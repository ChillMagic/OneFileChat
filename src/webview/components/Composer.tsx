import { For, Show, createEffect, createMemo, onCleanup, onMount } from 'solid-js';
import { state, actions } from '../store';
import {
  formatBytes,
  getSelectionLabel,
  hasLocalMarkdownAssetReference,
  isPromptHistoryShortcut,
  readAttachmentsFromFiles
} from '../utils';
import { scheduleAutoFollow, scrollToBottom, syncAutoFollowLoop, syncLayoutMetrics } from '../dom';
import { t } from '../../shared/i18n';

function ModelMenu(props: { onClose: () => void }) {
  const draft = () => state.menuDraftSelection;
  const activeProvider = createMemo(() =>
    draft()?.providerId ? state.availableProviders.find((p) => p.id === draft()!.providerId) ?? null : null
  );
  const activeModel = createMemo(() => {
    const ap = activeProvider();
    const mid = draft()?.modelId;
    return ap && mid ? ap.models.find((m) => m.id === mid) ?? null : null;
  });

  return (
    <div id="modelMenu" classList={{ 'model-menu': true, hidden: !state.isModelMenuOpen }} onClick={(e) => e.stopPropagation()}>
      <div class="model-menu-column">
        <p class="model-menu-title">{t('modelMenu.provider')}</p>
        <div id="providerList" class="model-menu-list">
          <Show when={state.availableProviders.length > 0} fallback={<p class="model-menu-empty">{t('modelMenu.noProvider')}</p>}>
            <For each={state.availableProviders}>
              {(p) => (
                <button
                  type="button"
                  classList={{
                    'model-menu-item': true,
                    'is-selected': draft()?.providerId === p.id
                  }}
                  onClick={() => actions.pickProvider(p.id)}
                >
                  {p.label}
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
      <div class="model-menu-column">
        <p class="model-menu-title">{t('modelMenu.model')}</p>
        <div id="modelList" class="model-menu-list">
          <Show when={activeProvider()} fallback={<p class="model-menu-empty">{t('modelMenu.selectProviderFirst')}</p>}>
            <For each={activeProvider()!.models}>
              {(m) => (
                <button
                  type="button"
                  classList={{
                    'model-menu-item': true,
                    'is-selected': draft()?.modelId === m.id
                  }}
                  onClick={() => {
                    actions.pickModel(m.id);
                    // 无子选项的模型：立即提交，等同于原版 commitModelSelection 行为
                    if (!Array.isArray(m.options) || m.options.length === 0) {
                      actions.pickOption(undefined);
                    }
                  }}
                >
                  {m.label}
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
      <div class="model-menu-column">
        <p class="model-menu-title">{t('modelMenu.options')}</p>
        <div id="optionList" class="model-menu-list">
          <Show
            when={activeModel()}
            fallback={<p class="model-menu-empty">{t('modelMenu.selectModelFirst')}</p>}
          >
            <Show
              when={Array.isArray(activeModel()!.options) && activeModel()!.options.length > 0}
              fallback={<p class="model-menu-empty">{t('modelMenu.noOptionsForModel')}</p>}
            >
              <For each={activeModel()!.options}>
                {(o) => (
                  <button
                    type="button"
                    classList={{
                      'model-menu-item': true,
                      'is-selected': draft()?.optionId === o.id
                    }}
                    onClick={() => actions.pickOption(o.id)}
                  >
                    {o.label}
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}

function AttachmentPreviews() {
  return (
    <div id="imagePreviewList" classList={{ 'image-preview-list': true, hidden: state.pendingAttachments.length === 0 }}>
      <For each={state.pendingAttachments}>
        {(att, idx) => {
          const isImage = att.kind === 'image' || (typeof att.mimeType === 'string' && att.mimeType.toLowerCase().startsWith('image/'));
          const display = att.name?.trim() || (isImage ? t('composer.imageItemFallback', { n: idx() + 1 }) : t('composer.fileItemFallback', { n: idx() + 1 }));
          const detailParts: string[] = [];
          if (att.mimeType?.trim()) detailParts.push(att.mimeType.trim());
          const sizeText = formatBytes(att.size);
          if (sizeText) detailParts.push(sizeText);
          return (
            <div class="image-preview-item">
              <Show
                when={isImage}
                fallback={<div class="image-preview-thumb file-preview-thumb">{t('composer.fileLabel')}</div>}
              >
                <img class="image-preview-thumb" alt={display} src={att.dataUrl} />
              </Show>
              <div class="image-preview-meta">
                <span class="image-preview-name">{display}</span>
                <span class="image-preview-detail">{detailParts.join(' · ')}</span>
              </div>
              <button
                class="image-preview-remove"
                type="button"
                disabled={state.isBusy || state.pendingSubmission !== null}
                onClick={() => actions.removeAttachment(att.id)}
              >
                {t('composer.removeAttachment')}
              </button>
            </div>
          );
        }}
      </For>
    </div>
  );
}

export function Composer() {
  let formRef: HTMLFormElement | undefined;
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let dragDepth = 0;

  function isLocked() {
    return state.isBusy || state.pendingSubmission !== null;
  }

  function autoResize() {
    if (!textareaRef) return;
    textareaRef.style.height = 'auto';
    const next = Math.min(textareaRef.scrollHeight, Math.round(window.innerHeight * 0.4));
    textareaRef.style.height = `${next}px`;
    syncLayoutMetrics();
  }

  onMount(() => {
    autoResize();
    syncLayoutMetrics();
    const onResize = () => {
      autoResize();
      syncLayoutMetrics();
    };
    window.addEventListener('resize', onResize);
    const onDocClick = (e: MouseEvent) => {
      if (!state.isModelMenuOpen) return;
      // Solid 通过 document 委托事件，stopPropagation 无法阻止此处的原生监听器，
      // 因此显式判断点击是否发生在模型菜单内部
      const target = e.target as Element | null;
      if (target && target.closest && target.closest('#modelMenuShell')) return;
      actions.toggleModelMenu(false);
    };
    document.addEventListener('click', onDocClick);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (state.isModelMenuOpen) {
          e.preventDefault();
          actions.toggleModelMenu(false);
        } else if (state.activeImagePreview) {
          e.preventDefault();
          actions.closeImagePreview();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    onCleanup(() => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
    });
  });

  // Auto-follow loop reacts to autoFollow/editing changes
  createEffect(() => {
    state.autoFollow;
    state.editingMessageId;
    syncAutoFollowLoop();
  });

  // Apply value pushed back from the large editor (composer mode)
  createEffect(() => {
    const ext = state.composerExternalValue;
    if (!ext || !textareaRef) return;
    textareaRef.value = ext.value;
    autoResize();
    // clear token so we don't re-apply on unrelated state changes
    actions.clearComposerExternalValue();
    textareaRef.focus();
    const len = textareaRef.value.length;
    try {
      textareaRef.setSelectionRange(len, len);
    } catch {
      /* noop */
    }
  });

  // Whenever new messages arrive (or content updates) auto-scroll if enabled
  createEffect(() => {
    state.chat?.messages.length;
    state.chat?.messages.map((m) => m.content?.length ?? 0).join('|');
    scheduleAutoFollow('auto');
  });

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    if (state.isBusy) {
      actions.stopGeneration();
      return;
    }
    if (state.pendingSubmission) return;
    const prompt = textareaRef?.value.trim() ?? '';
    if (!prompt && state.pendingAttachments.length === 0) return;
    if (!state.canSend) {
      // surface the error inline (no dedicated setter — we use store directly)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (state as any).error = t('composer.selectModelRequired');
      return;
    }
    const attachments = state.pendingAttachments.map((a) => ({
      name: a.name,
      mimeType: a.mimeType,
      size: a.size,
      dataUrl: a.dataUrl
    }));
    const ok = await actions.sendPrompt(prompt, attachments);
    if (ok) {
      if (textareaRef) {
        textareaRef.value = '';
        autoResize();
      }
      actions.clearAttachments();
      actions.setAutoFollow(true);
      scheduleAutoFollow('smooth');
    }
  }

  async function handleFiles(files: File[]) {
    try {
      const items = await readAttachmentsFromFiles(files, state.pendingAttachments.length);
      if (items.length > 0) {
        actions.addAttachments(items);
      }
    } catch (err) {
      (state as any).error = err instanceof Error ? err.message : String(err);
    }
  }

  const modelButtonLabel = createMemo(() => getSelectionLabel(state.availableProviders, state.currentSelection));
  const sendLabel = () => (state.isBusy ? t('composer.stopGeneration') : state.pendingSubmission ? t('composer.sending') : t('composer.send'));

  return (
    <footer class="composer-shell">
      <form
        id="composer"
        ref={(el) => (formRef = el)}
        class="composer"
        onSubmit={handleSubmit}
        onDragEnter={(e) => {
          if (isLocked()) return;
          const hasFiles = Array.from(e.dataTransfer?.items || []).some((i) => i.kind === 'file');
          if (!hasFiles) return;
          e.preventDefault();
          dragDepth += 1;
          formRef?.classList.add('is-drag-over');
        }}
        onDragOver={(e) => {
          if (isLocked()) return;
          const hasFiles = Array.from(e.dataTransfer?.items || []).some((i) => i.kind === 'file');
          if (!hasFiles) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={() => {
          dragDepth = Math.max(0, dragDepth - 1);
          if (dragDepth === 0) formRef?.classList.remove('is-drag-over');
        }}
        onDrop={async (e) => {
          dragDepth = 0;
          formRef?.classList.remove('is-drag-over');
          if (isLocked()) return;
          const files = Array.from(e.dataTransfer?.files || []);
          if (files.length === 0) return;
          e.preventDefault();
          await handleFiles(files);
        }}
      >
        <input
          id="imageInput"
          ref={(el) => (fileInputRef = el)}
          type="file"
          accept="image/*"
          multiple
          hidden
          disabled={isLocked()}
          onChange={async () => {
            if (!fileInputRef) return;
            if (isLocked()) {
              fileInputRef.value = '';
              return;
            }
            const files = Array.from(fileInputRef.files || []);
            fileInputRef.value = '';
            if (files.length === 0) return;
            await handleFiles(files);
          }}
        />
        <AttachmentPreviews />
        <textarea
          id="promptInput"
          ref={(el) => (textareaRef = el)}
          class="prompt-input"
          rows={1}
          disabled={isLocked()}
          placeholder={t('composer.promptPlaceholder')}
          onInput={() => autoResize()}
          onKeyDown={(e) => {
            if (isPromptHistoryShortcut(e)) {
              e.stopPropagation();
              return;
            }
            const isSubmit = e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
            if (!isSubmit) return;
            if ((e as any).isComposing || (e as any).keyCode === 229) return;
            e.preventDefault();
            formRef?.requestSubmit();
          }}
          onPaste={async (e) => {
            if (isLocked() || !e.clipboardData) return;
            const clipboardText = e.clipboardData.getData('text/plain') || '';
            const shouldImport = hasLocalMarkdownAssetReference(clipboardText);
            const files = Array.from(e.clipboardData.items || [])
              .filter((i) => i.kind === 'file')
              .map((i) => i.getAsFile())
              .filter((f): f is File => f instanceof File);
            if (files.length === 0 && !shouldImport) return;
            e.preventDefault();
            try {
              if (shouldImport && textareaRef) {
                const start = textareaRef.selectionStart;
                const end = textareaRef.selectionEnd;
                const result = await actions.importClipboardMarkdown(clipboardText);
                if (result.ok && typeof result.text === 'string') {
                  const v = textareaRef.value;
                  textareaRef.value = `${v.slice(0, start)}${result.text}${v.slice(end)}`;
                  const cursor = start + result.text.length;
                  textareaRef.setSelectionRange(cursor, cursor);
                  autoResize();
                  if (Array.isArray(result.attachments) && result.attachments.length > 0) {
                    const items = result.attachments.map((a, i) => ({
                      id: `clip-${Date.now()}-${i}`,
                      name: a.name ?? `pasted-${i}`,
                      mimeType: a.mimeType ?? 'application/octet-stream',
                      size: a.size ?? 0,
                      dataUrl: a.dataUrl,
                      kind: ((a.mimeType ?? '').toLowerCase().startsWith('image/') ? 'image' : 'file') as 'image' | 'file'
                    }));
                    actions.addAttachments(items);
                  }
                }
              }
              if (files.length > 0) await handleFiles(files);
            } catch (err) {
              (state as any).error = err instanceof Error ? err.message : String(err);
            }
            scrollToBottom('smooth');
          }}
        />
        <div class="composer-footer">
          <div class="composer-footer-group composer-footer-group-left">
            <button
              id="newChatButton"
              type="button"
              class="composer-icon-button"
              title={t('composer.newChat')}
              aria-label={t('composer.newChat')}
              onClick={() => actions.createNewChat()}
            >
              <span class="codicon codicon-new-file" aria-hidden="true" />
            </button>
            <button
              id="viewRawJsonButton"
              type="button"
              class="composer-icon-button"
              title={t('composer.viewRawJson')}
              aria-label={t('composer.viewRawJson')}
              onClick={() => actions.viewRawChatJson()}
            >
              <span class="codicon codicon-json" aria-hidden="true" />
            </button>
            <button
              id="messagePreviewToggleButton"
              type="button"
              class="composer-icon-button message-preview-toggle"
              title={t('composer.messagePreview')}
              aria-label={t('composer.messagePreview')}
              aria-controls="messagePreviewAside"
              aria-pressed={state.isMessagePreviewOpen}
              onClick={() => actions.setMessagePreviewOpen(!state.isMessagePreviewOpen)}
            >
              <span class="codicon codicon-open-preview" aria-hidden="true" />
            </button>
            <button
              id="addImageButton"
              type="button"
              class="composer-icon-button"
              title={t('composer.addAttachment')}
              aria-label={t('composer.addAttachment')}
              disabled={isLocked()}
              onClick={() => {
                if (!isLocked()) fileInputRef?.click();
              }}
            >
              <span class="codicon codicon-attach" aria-hidden="true" />
            </button>
            <button
              id="expandComposerButton"
              type="button"
              class="composer-icon-button"
              title={t('composer.expandEditor')}
              aria-label={t('composer.expandEditor')}
              disabled={isLocked()}
              onClick={() => {
                if (isLocked()) return;
                actions.openLargeEditor('composer', textareaRef?.value ?? '');
              }}
            >
              <span class="codicon codicon-screen-full" aria-hidden="true" />
            </button>
            <button
              id="trackButton"
              type="button"
              class="composer-icon-button"
              aria-pressed={state.autoFollow}
              title={state.autoFollow ? t('composer.autoFollowOn') : t('composer.autoFollowOff')}
              aria-label={state.autoFollow ? t('composer.autoFollowOn') : t('composer.autoFollowOff')}
              onClick={() => {
                actions.setAutoFollow(!state.autoFollow);
                if (state.autoFollow) scheduleAutoFollow('smooth');
              }}
            >
              <span class="codicon codicon-download" aria-hidden="true" />
            </button>
          </div>
          <span
            id="busyText"
            classList={{ 'busy-text': true, hidden: !state.isBusy && !state.pendingSubmission }}
          >
            {state.isBusy ? t('composer.busyGenerating') : state.pendingSubmission ? t('composer.busyWriting') : ''}
          </span>
          <div class="composer-footer-group composer-footer-group-right">
            <div id="modelMenuShell" class="model-menu-shell">
              <button
                id="modelMenuButton"
                type="button"
                class="composer-model-button"
                classList={{
                  'composer-model-button-warning': !state.canSend && state.availableProviders.length > 0
                }}
                disabled={isLocked() || state.availableProviders.length === 0}
                title={modelButtonLabel()}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.toggleModelMenu();
                }}
              >
                <span class="composer-model-button-label">{modelButtonLabel()}</span>
                <span class="codicon codicon-chevron-down" aria-hidden="true" />
              </button>
              <ModelMenu onClose={() => actions.toggleModelMenu(false)} />
            </div>
            <button
              id="manageProviderButton"
              type="button"
              class="composer-icon-button"
              disabled={isLocked()}
              title={t('composer.manageProvider')}
              aria-label={t('composer.manageProvider')}
              onClick={() => actions.manageProviderConfig()}
            >
              <span class="codicon codicon-settings-gear" aria-hidden="true" />
            </button>
            <button
              id="sendButton"
              type="submit"
              class="composer-send-button"
              classList={{
                'is-busy': state.isBusy,
                'is-pending': !state.isBusy && state.pendingSubmission !== null
              }}
              disabled={isLocked() && !state.isBusy}
              title={sendLabel()}
              aria-label={sendLabel()}
            >
              <span id="sendButtonSendIcon" classList={{ codicon: true, 'codicon-send': true, hidden: state.isBusy }} aria-hidden="true" />
              <span id="sendButtonStopIcon" classList={{ codicon: true, 'codicon-primitive-square': true, hidden: !state.isBusy }} aria-hidden="true" />
            </button>
          </div>
        </div>
      </form>
    </footer>
  );
}
