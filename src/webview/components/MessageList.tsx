import { For, Show, createEffect, createMemo, on, onCleanup, onMount } from 'solid-js';
import { actions, state } from '../store';
import type { ChatMessage, ChatMessageBodyPart, WebviewChatContentPart } from '../../shared/protocol';
import {
  formatTime,
  formatDuration,
  formatTokenCount,
  getDisplayedContent,
  getDisplayedContentHtml,
  getDisplayedContentParts,
  getDisplayedDuration,
  getDisplayedReasoningHtml,
  getDisplayedReasoningText,
  getDisplayedThinkingDuration,
  getDisplayedTokenStats,
  getDisplayedVersion,
  getEditableMarkdownContent,
  getMessageAnchorId,
  getMessageVersions,
  getRoleLabel,
  getVisibleContent,
  isCurrentVersion,
  canPreviewInlineImage,
  formatBytes
} from '../utils';
import { decorateCodeBlocks, registerBottomSentinel, getTrackedMessageId } from '../dom';
import { t } from '../../shared/i18n';

function MessageStat(props: { text: string; title?: string }) {
  return (
    <span class="message-stat" title={props.title}>
      {props.text}
    </span>
  );
}

function ContentPartsView(props: { parts: WebviewChatContentPart[]; role: ChatMessage['role']; messageId: string; surface: string }) {
  const prefix = () => 'message-content';
  return (
    <div class={`${prefix()}`}>
      <For each={props.parts}>
        {(part) => {
          if (part?.type === 'text') {
            const html: string | undefined = typeof part.html === 'string' && part.html ? part.html : undefined;
            const text: string = typeof part.text === 'string' ? part.text : '';
            if (html) {
              let ref: HTMLDivElement | undefined;
              createEffect(() => {
                if (ref) {
                  ref.innerHTML = html;
                  decorateCodeBlocks(ref, { messageId: props.messageId, surface: `${props.surface}-text` });
                }
              });
              return <div class={`${prefix()}-text`} ref={(el) => (ref = el)} />;
            }
            return <div class={`${prefix()}-text`}>{text}</div>;
          }
          if (part?.type === 'image') {
            const src: string = typeof part.src === 'string' ? part.src : '';
            const altRaw: string = typeof part.alt === 'string' ? part.alt.trim() : '';
            const alt: string = altRaw || t('messages.image');
            const relativePath: string | undefined = typeof part.relativePath === 'string' ? part.relativePath : undefined;
            const canPreview = canPreviewInlineImage(props.role);
            const img = (
              <img
                class={`${prefix()}-image`}
                src={src}
                alt={alt}
                loading="lazy"
                decoding="async"
              />
            );
            return (
              <figure class={`${prefix()}-image-block`}>
                <Show
                  when={canPreview}
                  fallback={img}
                >
                  <button
                    type="button"
                    class={`${prefix()}-image-trigger`}
                    title={t('messages.viewFullImage')}
                    aria-label={t('messages.viewFullImageOf', { alt })}
                    onClick={() => actions.openImagePreview(src, alt, relativePath, props.role)}
                  >
                    {img}
                  </button>
                </Show>
                <Show when={altRaw}>
                  <figcaption class={`${prefix()}-image-caption`}>{altRaw}</figcaption>
                </Show>
              </figure>
            );
          }
          if (part?.type === 'file') {
            const label: string = typeof part.label === 'string' && part.label.trim() ? part.label.trim() : t('messages.attachmentFile');
            const detail: string | undefined = typeof part.detail === 'string' && part.detail.trim() ? part.detail.trim() : undefined;
            return (
              <div class={`${prefix()}-file-block`}>
                <span class={`${prefix()}-file-icon codicon codicon-file`} aria-hidden="true" />
                <span class={`${prefix()}-file-meta`}>
                  <span class={`${prefix()}-file-label`}>{label}</span>
                  <Show when={detail}>{(d) => <span class={`${prefix()}-file-detail`}>{d()}</span>}</Show>
                </span>
              </div>
            );
          }
          return null;
        }}
      </For>
    </div>
  );
}

function MessageContent(props: { message: ChatMessage }) {
  const m = () => props.message;
  const content = createMemo(() => getDisplayedContent(m()));
  const contentHtml = createMemo(() => getDisplayedContentHtml(m()));
  const parts = createMemo(() => getDisplayedContentParts(m()));
  const isPendingFallback = createMemo(
    () =>
      m().role === 'assistant' &&
      !content() &&
      (m().status === 'pending' || m().status === 'canceled' || m().status === 'error')
  );

  return (
    <Show
      when={!isPendingFallback()}
      fallback={<div class="message-content pending">{getVisibleContent(m())}</div>}
    >
      <Show
        when={(parts()?.length ?? 0) > 0}
        fallback={
          <Show
            when={contentHtml()}
            fallback={<div class="message-content">{content()}</div>}
          >
            {(html) => {
              let ref: HTMLDivElement | undefined;
              createEffect(() => {
                const h = html();
                if (ref) {
                  ref.innerHTML = h;
                  decorateCodeBlocks(ref, { messageId: m().id, surface: 'message' });
                }
              });
              return <div class="message-content" ref={(el) => (ref = el)} />;
            }}
          </Show>
        }
      >
        <ContentPartsView parts={parts()!} role={m().role} messageId={m().id} surface="parts" />
      </Show>
    </Show>
  );
}

function ReasoningPanel(props: { message: ChatMessage }) {
  const m = () => props.message;
  const html = createMemo(() => getDisplayedReasoningHtml(m()));
  const text = createMemo(() => getDisplayedReasoningText(m()));
  const isPending = () => m().status === 'pending' && m().role === 'assistant';
  const shouldShow = () => Boolean(html() || text() || isPending());
  const isOpen = createMemo(() => {
    const known = state.reasoningOpen[m().id];
    return known === undefined ? isPending() : known;
  });

  return (
    <Show when={shouldShow()}>
      <details
        class="reasoning-panel"
        data-message-id={m().id}
        open={isOpen()}
        onToggle={(e) => actions.toggleReasoning(m().id, (e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary class="reasoning-summary">{isPending() && !html() ? t('messages.thinkingInProgress') : t('messages.thinkingPanelTitle')}</summary>
        <Show when={html() || text()}>
          <Show
            when={html()}
            fallback={<div class="reasoning-body">{text()}</div>}
          >
            {(h) => {
              let ref: HTMLDivElement | undefined;
              createEffect(() => {
                const inner = h();
                if (ref) {
                  ref.innerHTML = inner;
                  decorateCodeBlocks(ref, { messageId: m().id, surface: 'reasoning' });
                }
              });
              return <div class="reasoning-body" ref={(el) => (ref = el)} />;
            }}
          </Show>
        </Show>
      </details>
    </Show>
  );
}

function VersionPanel(props: { message: ChatMessage }) {
  const m = () => props.message;
  const versions = createMemo(() => getMessageVersions(m()));
  const isOpen = createMemo(() => {
    const known = state.versionPanelOpen[m().id];
    if (known !== undefined) return known;
    return Boolean(state.previewVersionId[m().id]);
  });
  return (
    <Show when={versions().length > 1}>
      <details
        class="message-versions"
        data-message-id={m().id}
        open={isOpen()}
        onToggle={(e) => actions.toggleVersionPanel(m().id, (e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary class="message-versions-summary">{t('messages.versionCount', { count: versions().length })}</summary>
        <div class="message-versions-body">
          <For each={versions().slice().reverse()}>
            {(version, reverseIdx) => {
              const chronoIdx = () => versions().length - 1 - reverseIdx();
              const isCurrent = () => isCurrentVersion(m(), version.id);
              const isSelected = () => getDisplayedVersion(m())?.id === version.id;
              return (
                <section
                  class="message-version-item"
                  classList={{ 'is-current': isCurrent(), 'is-selected': isSelected() }}
                  tabIndex={0}
                  role="button"
                  aria-pressed={isSelected() ? 'true' : 'false'}
                  onClick={() => actions.previewVersion(m().id, version.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      actions.previewVersion(m().id, version.id);
                    }
                  }}
                >
                  <div class="message-version-header">
                    <div class="message-version-meta">
                      <div class="message-version-badges">
                        <span class="message-version-label">{t('messages.versionLabel', { index: chronoIdx() + 1 })}</span>
                        <Show when={chronoIdx() === versions().length - 1}>
                          <span class="message-version-label is-secondary">{t('messages.latest')}</span>
                        </Show>
                        <Show when={chronoIdx() === 0}>
                          <span class="message-version-label is-secondary">{t('messages.first')}</span>
                        </Show>
                        <Show when={isCurrent()}>
                          <span class="message-version-label is-current">{t('messages.current')}</span>
                        </Show>
                        <Show when={typeof version.reasoningContent === 'string' && version.reasoningContent.trim()}>
                          <span class="message-version-label is-info">{t('messages.withReasoning')}</span>
                        </Show>
                      </div>
                      <Show when={formatTime(version.savedAt)}>
                        {(t) => <span class="message-version-time">{t()}</span>}
                      </Show>
                    </div>
                    <div class="message-version-actions">
                      <button
                        class="message-action message-version-action message-action-primary"
                        type="button"
                        disabled={state.isBusy || isCurrent()}
                        onClick={(e) => {
                          e.stopPropagation();
                          actions.restoreVersion(m().id, version.id);
                        }}
                      >
                        {t('messages.selectVersion')}
                      </button>
                      <button
                        class="message-action message-version-action"
                        type="button"
                        disabled={state.isBusy}
                        onClick={(e) => {
                          e.stopPropagation();
                          actions.copyMessageVersion(m().id, version.id);
                        }}
                      >
                        {t('messages.copyVersion')}
                      </button>
                      <button
                        class="message-action message-version-action"
                        type="button"
                        disabled={state.isBusy || isCurrent() || versions().length <= 1}
                        onClick={(e) => {
                          e.stopPropagation();
                          actions.deleteVersion(m().id, version.id);
                        }}
                      >
                        {t('messages.deleteVersion')}
                      </button>
                    </div>
                  </div>
                  <div class="message-version-preview">
                    {typeof version.content === 'string' ? version.content.slice(0, 200) : ''}
                    <Show when={typeof version.reasoningContent === 'string' && version.reasoningContent.trim()}>
                      <span class="message-version-reasoning-marker">{t('messages.withReasoningMarker')}</span>
                    </Show>
                  </div>
                </section>
              );
            }}
          </For>
        </div>
      </details>
    </Show>
  );
}

function MessageActions(props: { message: ChatMessage }) {
  const m = () => props.message;
  const hasContent = createMemo(() => getDisplayedContent(m()).trim().length > 0);
  const canCorrectCopy = () => m().status !== 'pending' && !state.isBusy;
  const canRewriteBranch = () => m().role === 'user' && hasContent() && m().status !== 'pending' && !state.isBusy;
  const isUserNoReply = () => m().role === 'user' && ((m().childIds?.length ?? 0) === 0);
  const canResendUser = () => m().role === 'user' && hasContent() && m().status !== 'pending' && !state.isBusy;
  const canResendAssistant = () => m().role === 'assistant' && m().status !== 'pending' && !state.isBusy;
  const canExportDelete = () => m().status !== 'pending' && !state.isBusy;
  const anyVisible = () =>
    hasContent() ||
    canCorrectCopy() ||
    canRewriteBranch() ||
    canResendUser() ||
    canResendAssistant() ||
    canExportDelete();

  function IconButton(p: { label: string; icon?: string; danger?: boolean; onClick: () => void }) {
    return (
      <button
        type="button"
        class="message-action"
        classList={{ 'message-action-danger': p.danger, 'message-action-icon': Boolean(p.icon) }}
        title={p.label}
        aria-label={p.label}
        onClick={p.onClick}
      >
        <Show when={p.icon} fallback={p.label}>
          {(icon) => <span class={`codicon codicon-${icon()}`} aria-hidden="true" />}
        </Show>
      </button>
    );
  }

  return (
    <Show when={anyVisible()}>
      <div class="message-actions">
        <Show when={hasContent()}>
          <IconButton
            label={t('messages.actionCopy')}
            icon="copy"
            onClick={() => {
              const dv = getDisplayedVersion(m());
              if (dv && !isCurrentVersion(m(), dv.id)) actions.copyMessageVersion(m().id, dv.id);
              else actions.copyMessage(m().id);
            }}
          />
        </Show>
        <Show when={canCorrectCopy()}>
          <IconButton label={t('messages.actionCorrect')} icon="edit" onClick={() => actions.startEditing(m().id, getEditableMarkdownContent(m()), 'correct')} />
        </Show>
        <Show when={canRewriteBranch()}>
          <IconButton label={t('messages.actionRewriteBranch')} icon="git-branch" onClick={() => actions.startEditing(m().id, getEditableMarkdownContent(m()), 'rewrite-branch')} />
        </Show>
        <Show when={canResendUser() || canResendAssistant()}>
          <IconButton
            label={isUserNoReply() ? t('messages.actionContinue') : t('messages.actionResend')}
            icon={isUserNoReply() ? 'play' : 'refresh'}
            onClick={() => actions.resend(m().id)}
          />
        </Show>
        <Show when={canExportDelete()}>
          <IconButton label={t('messages.actionExportBranch')} icon="export" onClick={() => actions.branchMessage(m().id)} />
          <IconButton label={t('messages.actionDeleteBranch')} icon="trash" danger onClick={() => actions.deleteBranch(m().id)} />
        </Show>
      </div>
    </Show>
  );
}

function BranchNav(props: { message: ChatMessage }) {
  const m = () => props.message;
  return (
    <Show when={(m().branchCount ?? 1) > 1}>
      <div class="message-branch-nav">
        <button
          class="message-branch-button"
          type="button"
          disabled={state.isBusy || (m().branchIndex ?? 1) <= 1}
          onClick={() => actions.selectSibling(m().id, 'previous')}
        >
          {'<'}
        </button>
        <span class="message-branch-label">{`${m().branchIndex ?? 1}/${m().branchCount ?? 1}`}</span>
        <button
          class="message-branch-button"
          type="button"
          disabled={state.isBusy || (m().branchIndex ?? 1) >= (m().branchCount ?? 1)}
          onClick={() => actions.selectSibling(m().id, 'next')}
        >
          {'>'}
        </button>
      </div>
    </Show>
  );
}

function MessageItem(props: { message: ChatMessage }) {
  const m = () => props.message;

  return (
    <article
      class="message"
      classList={{ user: m().role === 'user', assistant: m().role === 'assistant', system: m().role === 'system', error: m().status === 'error' }}
      data-message-id={m().id}
      id={getMessageAnchorId(m().id)}
    >
      <div class="message-card">
        <div class="message-meta">
          <span class="message-role">{getRoleLabel(m())}</span>
          <Show when={formatTime(m().createdAt)}>{(t) => <span class="message-time">{t()}</span>}</Show>
          <Show when={formatDuration(getDisplayedThinkingDuration(m()))}>
            {(label) => <MessageStat text={t('messages.thinkingLabel', { value: label() })} />}
          </Show>
          <Show when={formatDuration(getDisplayedDuration(m()))}>
            {(label) => <MessageStat text={t('messages.totalTimeLabel', { value: label() })} />}
          </Show>
          <Show when={getDisplayedTokenStats(m())}>
            {(stats) => {
              const detail = createMemo(() => {
                const s = stats();
                const parts: string[] = [];
                const inp = formatTokenCount(s.inputTokens);
                const out = formatTokenCount(s.outputTokens);
                const cached = formatTokenCount(s.cachedInputTokens);
                if (inp) parts.push(t('messages.inputTokensLabel', { value: inp }));
                if (out) parts.push(t('messages.outputTokensLabel', { value: out }));
                if (cached) parts.push(t('messages.cachedInputTokensLabel', { value: cached }));
                return parts.join(' / ');
              });
              return <MessageStat text={t('messages.tokensSuffix', { value: formatTokenCount(stats().totalTokens) })} title={detail()} />;
            }}
          </Show>
          <BranchNav message={m()} />
        </div>
        <Show when={m().role === 'assistant'}>
          <ReasoningPanel message={m()} />
        </Show>
        <MessageContent message={m()} />
        <VersionPanel message={m()} />
        <MessageActions message={m()} />
      </div>
    </article>
  );
}

import { MessagePreview } from './MessagePreview';

export function MessageList() {
  const messages = createMemo(() => state.chat?.messages ?? []);
  const hasMessages = createMemo(() => messages().length > 0);

  let bottomSentinelRef: HTMLDivElement | undefined;
  let messagesSectionRef: HTMLElement | undefined;
  createEffect(() => {
    if (bottomSentinelRef) registerBottomSentinel(bottomSentinelRef);
  });

  // 滚动时同步消息预览侧栏的当前激活项（与原版一致）
  onMount(() => {
    let pending = false;
    const sync = () => {
      pending = false;
      if (!messagesSectionRef) return;
      const list = state.chat?.messages ?? [];
      if (list.length === 0) {
        actions.setActivePreviewMessageId(null);
        return;
      }
      actions.setActivePreviewMessageId(getTrackedMessageId(messagesSectionRef));
    };
    const onScroll = () => {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(sync);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    // 消息列表变化后也重新跟踪
    createEffect(() => {
      // 触发依赖：消息条数、内容长度
      state.chat?.messages.length;
      state.chat?.messages.map((m) => (m.content?.length ?? 0)).join('|');
      onScroll();
    });
    onCleanup(() => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    });
  });

  return (
    <>
      <Show when={!hasMessages()}>
        <section id="emptyState" class="empty-state">
          <p>{t('messages.emptyState')}</p>
        </section>
      </Show>
      <div id="chatLayout" class="chat-layout">
        <div class="chat-main">
          <section ref={(el) => (messagesSectionRef = el)} id="messages" classList={{ messages: true, hidden: !hasMessages() }}>
            <For each={messages()}>{(m) => <MessageItem message={m} />}</For>
            <div ref={(el) => (bottomSentinelRef = el)} class="messages-bottom-sentinel" aria-hidden="true" />
          </section>
        </div>
        <MessagePreview />
      </div>
    </>
  );
}
