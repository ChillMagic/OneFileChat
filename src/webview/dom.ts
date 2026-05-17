import { actions, state } from './store';
import { t } from '../shared/i18n';

// ===== Code-block decoration =====
// Mirrors the original decorateCodeBlocks() but reads/writes state via the Solid store
// and uses event delegation on the message-content container.

export interface DecorateContext {
  messageId: string;
  surface: string;
}

function getLanguageLabel(codeBlock: HTMLElement): string {
  const ds = codeBlock.dataset.codeLanguage?.trim();
  if (ds) return ds;
  const code = codeBlock.querySelector('code');
  if (!(code instanceof HTMLElement)) return t('common.code');
  const cls = Array.from(code.classList).find((c) => c.startsWith('language-'));
  if (!cls) return t('common.code');
  const norm = cls.slice('language-'.length).replace(/-/g, ' ').trim();
  return norm || t('common.code');
}

function buildKey(messageId: string, surface: string, index: number): string {
  return `${messageId}:${surface}:${index}`;
}

function applyCollapsed(wrapper: HTMLElement, collapsed: boolean) {
  wrapper.classList.toggle('is-collapsed', collapsed);
  const content = wrapper.querySelector<HTMLElement>('.message-code-block-content');
  if (content) content.hidden = collapsed;
  const toggle = wrapper.querySelector<HTMLButtonElement>('.message-code-block-toggle');
  if (toggle) {
    toggle.textContent = collapsed ? t('dom.expandCode') : t('dom.collapseCode');
    toggle.setAttribute('aria-expanded', String(!collapsed));
  }
}

function applyCopyLabel(wrapper: HTMLElement, label: string) {
  const btn = wrapper.querySelector<HTMLButtonElement>('.message-code-block-copy');
  if (btn) btn.textContent = label;
}

function syncFromState(wrapper: HTMLElement) {
  const key = wrapper.dataset.codeBlockKey;
  if (!key) return;
  applyCollapsed(wrapper, state.codeBlockCollapsed[key] === true);
  applyCopyLabel(wrapper, state.codeBlockCopyFeedback[key] || t('dom.copyCode'));
}

export function decorateCodeBlocks(container: HTMLElement | null, ctx: DecorateContext): void {
  if (!container || !ctx.messageId) return;
  const blocks = Array.from(container.querySelectorAll<HTMLElement>('pre[data-code-block="true"]'));
  blocks.forEach((codeBlockElement, codeBlockIndex) => {
    if (codeBlockElement.closest('.message-code-block')) return;
    const key = buildKey(ctx.messageId, ctx.surface, codeBlockIndex);
    const lang = getLanguageLabel(codeBlockElement);
    const parent = codeBlockElement.parentNode;
    if (!parent) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'message-code-block';
    wrapper.dataset.codeBlockKey = key;
    wrapper.dataset.codeLanguage = lang;

    const toolbar = document.createElement('div');
    toolbar.className = 'message-code-block-toolbar';

    const meta = document.createElement('div');
    meta.className = 'message-code-block-meta';
    const language = document.createElement('span');
    language.className = 'message-code-block-language';
    language.textContent = lang;
    meta.appendChild(language);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'message-code-block-actions';

    const toggle = document.createElement('button');
    toggle.className = 'message-code-block-button message-code-block-toggle';
    toggle.type = 'button';
    toggle.dataset.codeBlockAction = 'toggle';
    toggle.dataset.codeBlockKey = key;

    const copy = document.createElement('button');
    copy.className = 'message-code-block-button message-code-block-copy';
    copy.type = 'button';
    copy.dataset.codeBlockAction = 'copy';
    copy.dataset.codeBlockKey = key;

    actionsEl.appendChild(toggle);
    actionsEl.appendChild(copy);
    toolbar.appendChild(meta);
    toolbar.appendChild(actionsEl);

    const content = document.createElement('div');
    content.className = 'message-code-block-content';

    codeBlockElement.classList.add('message-code-block-pre');

    parent.insertBefore(wrapper, codeBlockElement);
    wrapper.appendChild(toolbar);
    wrapper.appendChild(content);
    content.appendChild(codeBlockElement);

    syncFromState(wrapper);
  });

  // Re-sync any wrappers that already existed (e.g. retained across stream updates)
  for (const w of container.querySelectorAll<HTMLElement>('.message-code-block[data-code-block-key]')) {
    syncFromState(w);
  }
}

export function attachCodeBlockDelegation(root: HTMLElement): void {
  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const btn = target.closest<HTMLElement>('[data-code-block-action]');
    if (!btn) return;
    const action = btn.dataset.codeBlockAction;
    const wrapper = btn.closest<HTMLElement>('.message-code-block[data-code-block-key]');
    if (!wrapper) return;
    const key = wrapper.dataset.codeBlockKey;
    if (!key) return;

    if (action === 'toggle') {
      actions.toggleCodeBlock(key);
      applyCollapsed(wrapper, state.codeBlockCollapsed[key] === true);
      return;
    }

    if (action === 'copy') {
      const pre = wrapper.querySelector<HTMLElement>('pre[data-code-block="true"]');
      const codeElement = pre?.querySelector('code');
      const text = codeElement?.textContent ?? pre?.textContent ?? '';
      actions.copyCodeBlock(text);
      actions.setCodeBlockCopyFeedback(key, t('dom.codeCopied'));
      applyCopyLabel(wrapper, t('dom.codeCopied'));
      window.setTimeout(() => {
        // After 1600ms feedback expires; re-sync from store
        syncFromState(wrapper);
      }, 1700);
    }
  });
}

// ===== Image copy =====
export async function copyImageElement(img: HTMLImageElement): Promise<void> {
  if (!navigator.clipboard || typeof (navigator.clipboard as any).write !== 'function' || typeof ClipboardItem === 'undefined') {
    throw new Error(t('lightbox.notSupported'));
  }
  if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) {
    await new Promise<void>((resolve, reject) => {
      const onLoad = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error(t('lightbox.cannotLoad')));
      };
      const cleanup = () => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onErr);
      };
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onErr);
    });
  }
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) throw new Error(t('lightbox.cannotCreateBuffer'));
  ctx2d.drawImage(img, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t('lightbox.cannotGenerateBlob')))), 'image/png')
  );
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

// ===== Scroll / auto-follow =====
let autoFollowLoopTimer = 0;
let autoFollowScrollPending = false;
let queuedBehavior: ScrollBehavior = 'auto';
let bottomSentinel: HTMLElement | null = null;

export function registerBottomSentinel(el: HTMLElement) {
  bottomSentinel = el;
}

function getScrollRoot(): Element {
  return (document.scrollingElement || document.documentElement) as Element;
}

function scrollElementToBottom(el: HTMLElement | null, behavior: ScrollBehavior) {
  if (!el) return;
  const top = Math.max(0, el.scrollHeight - el.clientHeight);
  if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior });
  else el.scrollTop = top;
}

export function scrollToBottom(behavior: ScrollBehavior = 'auto'): void {
  if (bottomSentinel?.isConnected) {
    bottomSentinel.scrollIntoView({ behavior, block: 'end', inline: 'nearest' });
  }
  const root = getScrollRoot() as HTMLElement;
  const rootTop = Math.max(
    0,
    Math.max(root.scrollHeight, document.body?.scrollHeight || 0, document.documentElement.scrollHeight) - root.clientHeight
  );
  if (typeof (root as any).scrollTo === 'function') (root as any).scrollTo({ top: rootTop, behavior });
  else root.scrollTop = rootTop;
  scrollElementToBottom(document.body, behavior);
  let ancestor: HTMLElement | null = bottomSentinel?.parentElement ?? null;
  while (ancestor) {
    if (ancestor.scrollHeight > ancestor.clientHeight + 1) scrollElementToBottom(ancestor, behavior);
    ancestor = ancestor.parentElement;
  }
  window.scrollTo({ top: rootTop, behavior });
}

export function scheduleAutoFollow(behavior: ScrollBehavior = 'auto'): void {
  if (!state.autoFollow || state.editingMessageId) {
    queuedBehavior = 'auto';
    return;
  }
  if (behavior === 'smooth') queuedBehavior = 'smooth';
  if (autoFollowScrollPending) return;
  autoFollowScrollPending = true;
  window.requestAnimationFrame(() => {
    autoFollowScrollPending = false;
    if (!state.autoFollow || state.editingMessageId) {
      queuedBehavior = 'auto';
      return;
    }
    const b = queuedBehavior;
    queuedBehavior = 'auto';
    scrollToBottom(b);
  });
}

export function startAutoFollowLoop(): void {
  if (autoFollowLoopTimer !== 0) return;
  autoFollowLoopTimer = window.setInterval(() => {
    if (!state.autoFollow || state.editingMessageId) {
      window.clearInterval(autoFollowLoopTimer);
      autoFollowLoopTimer = 0;
      return;
    }
    scheduleAutoFollow('auto');
  }, 120);
}

export function stopAutoFollowLoop(): void {
  if (autoFollowLoopTimer === 0) return;
  window.clearInterval(autoFollowLoopTimer);
  autoFollowLoopTimer = 0;
}

export function syncAutoFollowLoop(): void {
  if (state.autoFollow && !state.editingMessageId) startAutoFollowLoop();
  else stopAutoFollowLoop();
}

// Track which message is in view (for sidebar preview highlight)
export function getTrackedMessageId(messagesContainer: HTMLElement): string | null {
  const nodes = messagesContainer.querySelectorAll<HTMLElement>('.message[data-message-id]');
  if (nodes.length === 0) return null;
  const composer = document.querySelector<HTMLElement>('.composer-shell');
  const composerHeight = composer ? composer.getBoundingClientRect().height : 0;
  const topPad = 16;
  const bottomPad = 16;
  const readableTop = topPad;
  const readableBottom = Math.max(readableTop, window.innerHeight - composerHeight - bottomPad);
  const line = Math.min(readableBottom, readableTop + 36);
  let prev: string | null = null;
  for (const node of Array.from(nodes)) {
    const id = node.dataset.messageId;
    if (!id) continue;
    const rect = node.getBoundingClientRect();
    if (rect.top <= line && rect.bottom >= line) return id;
    if (rect.top > line) return prev || id;
    prev = id;
  }
  return prev;
}

export function syncLayoutMetrics(): void {
  const composer = document.querySelector<HTMLElement>('.composer-shell');
  const h = composer ? Math.ceil(composer.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--composer-shell-height', `${h}px`);
}
