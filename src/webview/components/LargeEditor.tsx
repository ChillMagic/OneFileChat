import { For, Show, createEffect, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { state, actions } from '../store';
import {
  formatBytes,
  getPromptHistoryDirection,
  hasLocalMarkdownAssetReference,
  isPromptHistoryShortcut,
  readAttachmentsFromFiles
} from '../utils';
import { t } from '../../shared/i18n';

type EditorMode = 'composer' | 'edit-correct' | 'edit-rewrite';

function titleFor(mode: EditorMode) {
  if (mode === 'composer') return t('editor.titleComposer');
  if (mode === 'edit-rewrite') return t('editor.titleRewrite');
  return t('editor.titleEdit');
}

function placeholderFor(mode: EditorMode) {
  if (mode === 'composer') return t('editor.placeholderComposer');
  if (mode === 'edit-rewrite') return t('editor.placeholderRewrite');
  return t('editor.placeholderEdit');
}

function LargeAttachmentList(props: { mode: EditorMode }) {
  const items = () =>
    props.mode === 'composer' ? state.pendingAttachments : state.largeEditorAttachments;
  const removeFn = (id: string) =>
    props.mode === 'composer'
      ? actions.removeAttachment(id)
      : actions.removeLargeEditorAttachment(id);
  return (
    <Show when={items().length > 0}>
      <div class="large-editor-attachments">
        <For each={items()}>
          {(att, idx) => {
            const isImage =
              att.kind === 'image' ||
              (typeof att.mimeType === 'string' && att.mimeType.toLowerCase().startsWith('image/'));
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
                  onClick={() => removeFn(att.id)}
                >
                  {t('composer.removeAttachment')}
                </button>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

export function LargeEditor() {
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let dragDepth = 0;
  const [isDragOver, setDragOver] = createSignal(false);
  const [canApply, setCanApply] = createSignal(false);

  const isOpen = () => state.largeEditor !== null;
  const mode = (): EditorMode => state.largeEditor?.mode ?? 'composer';
  const isComposerMode = () => mode() === 'composer';

  function recomputeCanApply() {
    const v = textareaRef?.value ?? '';
    if (isComposerMode()) {
      setCanApply(v.length > 0 || state.pendingAttachments.length > 0);
    } else {
      setCanApply(v.trim().length > 0 || state.largeEditorAttachments.length > 0);
    }
  }

  // Seed textarea whenever `largeEditorSeedNonce` bumps (on open + async
  // markdown-asset import). Reading `state.largeEditor.value` is intentionally
  // avoided here so per-keystroke `setLargeEditorValue` (which mutates `.value`
  // in place) does NOT retrigger this effect — preserving native undo.
  createEffect(() => {
    state.largeEditorSeedNonce;
    const le = untrack(() => state.largeEditor);
    if (!le || !textareaRef) return;
    textareaRef.value = le.value;
    queueMicrotask(() => {
      textareaRef?.focus();
      const len = textareaRef?.value.length ?? 0;
      try {
        textareaRef?.setSelectionRange(len, len);
      } catch {
        /* noop */
      }
    });
    recomputeCanApply();
  });

  // Re-evaluate canApply when attachments change
  createEffect(() => {
    state.pendingAttachments.length;
    state.largeEditorAttachments.length;
    recomputeCanApply();
  });

  function closeForCurrentMode() {
    if (isComposerMode()) {
      pushValueToStore();
      actions.closeLargeEditor();
    } else actions.cancelEditing(); // also closes the large editor
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isOpen()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeForCurrentMode();
      }
    };
    document.addEventListener('keydown', onKey);
    onCleanup(() => document.removeEventListener('keydown', onKey));
  });

  function isLocked() {
    return state.isBusy || state.pendingSubmission !== null;
  }

  async function handleFiles(files: File[]) {
    try {
      const existing = isComposerMode()
        ? state.pendingAttachments.length
        : state.largeEditorAttachments.length;
      const items = await readAttachmentsFromFiles(files, existing);
      if (items.length === 0) return;
      if (isComposerMode()) actions.addAttachments(items);
      else actions.addLargeEditorAttachments(items);
    } catch (err) {
      (state as any).error = err instanceof Error ? err.message : String(err);
    }
  }

  function pushValueToStore() {
    if (!textareaRef) return;
    actions.setLargeEditorValue(textareaRef.value);
    recomputeCanApply();
  }

  function doApply(continueGeneration?: boolean) {
    pushValueToStore();
    actions.applyLargeEditor(continueGeneration);
  }

  function onTextareaKey(e: KeyboardEvent) {
    // Stop outer listeners from hijacking native undo/redo (Ctrl/Cmd + Z / Y).
    const promptHistoryDirection = getPromptHistoryDirection(e);
    if (promptHistoryDirection) {
      e.stopPropagation();
      if (isComposerMode() && actions.stepComposerHistory(promptHistoryDirection)) {
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (canApply()) doApply();
    }
  }

  return (
    <Show when={isOpen()}>
      <div
        class="large-editor"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeForCurrentMode();
        }}
      >
        <div
          class="large-editor-panel"
          classList={{ 'is-drag-over': isDragOver() }}
          role="dialog"
          aria-modal="true"
          aria-label={titleFor(mode())}
          onDragEnter={(e) => {
            if (isLocked()) return;
            const hasFiles = Array.from(e.dataTransfer?.items || []).some((i) => i.kind === 'file');
            if (!hasFiles) return;
            e.preventDefault();
            dragDepth += 1;
            setDragOver(true);
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
            if (dragDepth === 0) setDragOver(false);
          }}
          onDrop={async (e) => {
            dragDepth = 0;
            setDragOver(false);
            if (isLocked()) return;
            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length === 0) return;
            e.preventDefault();
            await handleFiles(files);
          }}
        >
          <div class="large-editor-toolbar">
            <div class="large-editor-meta">
              <span class="large-editor-title">{titleFor(mode())}</span>
              <span class="large-editor-hint">
                {mode() === 'composer'
                  ? t('editor.hintComposer')
                  : mode() === 'edit-rewrite'
                  ? t('editor.hintRewrite')
                  : t('editor.hintEdit')}
              </span>
            </div>
            <div class="large-editor-actions">
              <input
                ref={(el) => (fileInputRef = el)}
                type="file"
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
              <button
                type="button"
                class="large-editor-button"
                title={t('editor.addAttachment')}
                aria-label={t('editor.addAttachment')}
                disabled={isLocked()}
                onClick={() => {
                  if (!isLocked()) fileInputRef?.click();
                }}
              >
                <span class="codicon codicon-attach" aria-hidden="true" />
                <span>{t('editor.addAttachment')}</span>
              </button>
              <button
                type="button"
                class="large-editor-button"
                onClick={() => closeForCurrentMode()}
              >
                {t('editor.cancel')}
              </button>
              <Show when={mode() === 'edit-rewrite'}>
                <button
                  type="button"
                  class="large-editor-button large-editor-button-primary"
                  disabled={!canApply()}
                  onClick={() => doApply(true)}
                >
                  {t('editor.createAndContinue')}
                </button>
              </Show>
              <button
                type="button"
                class="large-editor-button large-editor-button-primary"
                disabled={!canApply()}
                onClick={() => doApply()}
              >
                {mode() === 'composer' ? t('editor.applyComposer') : mode() === 'edit-rewrite' ? t('editor.applyRewrite') : t('editor.applyEdit')}
              </button>
            </div>
          </div>
          <LargeAttachmentList mode={mode()} />
          <textarea
            ref={(el) => (textareaRef = el)}
            class="large-editor-textarea"
            placeholder={placeholderFor(mode())}
            onInput={() => pushValueToStore()}
            onKeyDown={onTextareaKey}
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
                    pushValueToStore();
                    if (Array.isArray(result.attachments) && result.attachments.length > 0) {
                      const items = result.attachments.map((a, i) => ({
                        id: `clip-${Date.now()}-${i}`,
                        name: a.name ?? `pasted-${i}`,
                        mimeType: a.mimeType ?? 'application/octet-stream',
                        size: a.size ?? 0,
                        dataUrl: a.dataUrl,
                        kind: ((a.mimeType ?? '').toLowerCase().startsWith('image/') ? 'image' : 'file') as
                          | 'image'
                          | 'file'
                      }));
                      if (isComposerMode()) actions.addAttachments(items);
                      else actions.addLargeEditorAttachments(items);
                    }
                  }
                }
                if (files.length > 0) await handleFiles(files);
              } catch (err) {
                (state as any).error = err instanceof Error ? err.message : String(err);
              }
            }}
          />
        </div>
      </div>
    </Show>
  );
}
