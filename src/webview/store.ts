import { createStore, produce } from 'solid-js/store';
import { createSignal } from 'solid-js';
import type {
  ChatAttachment,
  ChatModelSelection,
  HostToWebviewMessage,
  WebviewChatFile,
  WebviewCommonConfigState,
  WebviewConfigFieldKey,
  WebviewConfigFieldState,
  WebviewDocumentState,
  WebviewIncomingAttachment,
  WebviewProviderItem
} from '../shared/protocol';
import { onHostMessage, post, createRequestId } from './bridge';
import { hasLocalMarkdownAssetReference } from './utils';
import { t } from '../shared/i18n';

export interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  kind: 'image' | 'file';
}

export interface ConfigDraft {
  inherit: boolean;
  content: string;
  dirty: boolean;
}

export interface PendingSubmission {
  requestId: string;
  prompt: string;
  attachments: WebviewIncomingAttachment[];
}

export interface AppState {
  chat: WebviewChatFile | null;
  fileName: string;
  isBusy: boolean;
  error: string;
  availableProviders: WebviewProviderItem[];
  currentSelection: ChatModelSelection | null;
  canSend: boolean;
  commonConfig: WebviewCommonConfigState;
  configFields: { systemPrompt: WebviewConfigFieldState; messageTemplate: WebviewConfigFieldState };
  configDrafts: { systemPrompt: ConfigDraft; messageTemplate: ConfigDraft };
  pendingAttachments: PendingAttachment[];
  largeEditorAttachments: PendingAttachment[];
  pendingSubmission: PendingSubmission | null;
  isModelMenuOpen: boolean;
  menuDraftSelection: ChatModelSelection | null;
  editingMessageId: string | null;
  editingMode: 'correct' | 'rewrite-branch';
  editDraft: string;
  autoFollow: boolean;
  isMessagePreviewOpen: boolean;
  activePreviewMessageId: string | null;
  reasoningOpen: Record<string, boolean>;
  versionPanelOpen: Record<string, boolean>;
  previewVersionId: Record<string, string>;
  codeBlockCollapsed: Record<string, boolean>;
  codeBlockCopyFeedback: Record<string, string>;
  activeImagePreview: { src: string; alt?: string; relativePath?: string; role?: string } | null;
  imagePreviewCopyFeedback: string;
  isCopyingImagePreview: boolean;
  largeEditor: { mode: 'composer' | 'edit-correct' | 'edit-rewrite'; value: string } | null;
  largeEditorSeedNonce: number;
  composerExternalValue: { value: string; nonce: number } | null;
}

function emptyConfigField(): WebviewConfigFieldState {
  return {
    inherit: false,
    content: '',
    effectiveContent: '',
    source: 'none',
    missingInheritedConfig: false,
    missingInheritedValue: false,
    hasRetainedDraft: false
  };
}
function emptyCommonConfig(): WebviewCommonConfigState {
  return { hasMissingSelection: false, options: [] };
}
function emptyDraft(): ConfigDraft {
  return { inherit: false, content: '', dirty: false };
}

const initial: AppState = {
  chat: null,
  fileName: '',
  isBusy: false,
  error: '',
  availableProviders: [],
  currentSelection: null,
  canSend: false,
  commonConfig: emptyCommonConfig(),
  configFields: { systemPrompt: emptyConfigField(), messageTemplate: emptyConfigField() },
  configDrafts: { systemPrompt: emptyDraft(), messageTemplate: emptyDraft() },
  pendingAttachments: [],
  largeEditorAttachments: [],
  pendingSubmission: null,
  isModelMenuOpen: false,
  menuDraftSelection: null,
  editingMessageId: null,
  editingMode: 'correct',
  editDraft: '',
  autoFollow: false,
  isMessagePreviewOpen: false,
  activePreviewMessageId: null,
  reasoningOpen: {},
  versionPanelOpen: {},
  previewVersionId: {},
  codeBlockCollapsed: {},
  codeBlockCopyFeedback: {},
  activeImagePreview: null,
  imagePreviewCopyFeedback: '',
  isCopyingImagePreview: false,
  largeEditor: null,
  largeEditorSeedNonce: 0,
  composerExternalValue: null
};

export const [state, setState] = createStore<AppState>(initial);

// Pending submission resolvers for sendPrompt
const sendPromptResolvers = new Map<string, (ok: boolean) => void>();
// Clipboard markdown import resolvers
const clipboardResolvers = new Map<
  string,
  (result: { ok: boolean; text?: string; attachments?: WebviewIncomingAttachment[]; error?: string }) => void
>();
const editorAttachmentResolvers = new Map<
  string,
  (result: { ok: boolean; attachments?: ChatAttachment[]; error?: string }) => void
>();

onHostMessage((msg) => {
  switch (msg.type) {
    case 'document':
      applyDocument(msg.value, msg.state);
      break;
    case 'streamChunk':
      applyStreamChunk(msg);
      break;
    case 'sendPromptResult': {
      const r = sendPromptResolvers.get(msg.requestId);
      if (r) {
        sendPromptResolvers.delete(msg.requestId);
        r(msg.ok);
      }
      break;
    }
    case 'clipboardMarkdownAttachments': {
      const r = clipboardResolvers.get(msg.requestId);
      if (r) {
        clipboardResolvers.delete(msg.requestId);
        r({ ok: msg.ok, text: msg.text, attachments: msg.attachments, error: msg.error });
      }
      break;
    }
    case 'editorAttachmentsPersisted': {
      const r = editorAttachmentResolvers.get(msg.requestId);
      if (r) {
        editorAttachmentResolvers.delete(msg.requestId);
        r({ ok: msg.ok, attachments: msg.attachments, error: msg.error });
      }
      break;
    }
  }
});

function applyDocument(value: WebviewChatFile, ds: WebviewDocumentState) {
  setState(
    produce((s) => {
      s.chat = value;
      s.fileName = ds.fileName ?? '';
      s.isBusy = !!ds.isBusy;
      s.error = ds.error ?? '';
      s.availableProviders = ds.availableProviders ?? [];
      s.currentSelection = ds.currentSelection ?? null;
      s.canSend = !!ds.canSend;
      s.commonConfig = ds.commonConfig ?? emptyCommonConfig();
      s.configFields.systemPrompt = ds.systemPrompt ?? emptyConfigField();
      s.configFields.messageTemplate = ds.messageTemplate ?? emptyConfigField();
      syncDraft(s, 'systemPrompt');
      syncDraft(s, 'messageTemplate');
      // Clean up stale per-message state
      const ids = new Set(value.messages.map((m) => m.id));
      for (const k of Object.keys(s.reasoningOpen)) if (!ids.has(k)) delete s.reasoningOpen[k];
      for (const k of Object.keys(s.versionPanelOpen)) if (!ids.has(k)) delete s.versionPanelOpen[k];
      for (const k of Object.keys(s.previewVersionId)) if (!ids.has(k)) delete s.previewVersionId[k];
    })
  );
}

function syncDraft(s: AppState, key: WebviewConfigFieldKey) {
  const saved = s.configFields[key];
  const draft = s.configDrafts[key];
  if (!draft.dirty) {
    draft.inherit = saved.inherit;
    draft.content = saved.content;
  }
}

function applyStreamChunk(msg: Extract<HostToWebviewMessage, { type: 'streamChunk' }>) {
  setState(
    produce((s) => {
      const chat = s.chat;
      if (!chat) return;
      const m = chat.messages.find((x) => x.id === msg.messageId);
      if (!m) return;
      if (typeof msg.content === 'string') m.content = msg.content;
      else if (msg.contentDelta) m.content = (m.content ?? '') + msg.contentDelta;
      if (typeof msg.contentHtml === 'string') m.contentHtml = msg.contentHtml;
      if (typeof msg.reasoningContent === 'string') m.reasoningContent = msg.reasoningContent;
      else if (msg.reasoningDelta) m.reasoningContent = (m.reasoningContent ?? '') + msg.reasoningDelta;
      if (typeof msg.reasoningContentHtml === 'string') m.reasoningContentHtml = msg.reasoningContentHtml;
    })
  );
}

// ---- actions ----
export const actions = {
  ready() {
    post({ type: 'ready' });
  },
  setAutoFollow(v: boolean) {
    setState('autoFollow', v);
  },
  toggleModelMenu(open?: boolean) {
    const next = typeof open === 'boolean' ? open : !state.isModelMenuOpen;
    setState(
      produce((s) => {
        s.isModelMenuOpen = next;
        s.menuDraftSelection = next ? (s.currentSelection ? { ...s.currentSelection } : null) : null;
      })
    );
  },
  pickProvider(providerId: string) {
    setState('menuDraftSelection', { providerId, modelId: '', optionId: undefined });
  },
  pickModel(modelId: string) {
    const cur = state.menuDraftSelection;
    if (!cur) return;
    setState('menuDraftSelection', { providerId: cur.providerId, modelId, optionId: undefined });
  },
  pickOption(optionId: string | undefined) {
    const cur = state.menuDraftSelection;
    if (!cur || !cur.providerId || !cur.modelId) return;
    post({ type: 'updateModelSelection', providerId: cur.providerId, modelId: cur.modelId, optionId });
    setState(
      produce((s) => {
        s.isModelMenuOpen = false;
        s.menuDraftSelection = null;
      })
    );
  },
  setCommonConfigId(id: string | null) {
    post({ type: 'updateCommonConfigId', commonConfigId: id });
    setState(
      produce((s) => {
        s.commonConfig.selectedId = id ?? undefined;
        const match = s.commonConfig.options.find((o) => o.id === id);
        s.commonConfig.selectedName = match ? match.name : undefined;
        s.commonConfig.hasMissingSelection = Boolean(id) && !match;
      })
    );
  },
  setDraft(key: WebviewConfigFieldKey, patch: Partial<ConfigDraft>) {
    setState(
      produce((s) => {
        const d = s.configDrafts[key];
        Object.assign(d, patch);
        const saved = s.configFields[key];
        d.dirty = d.inherit !== saved.inherit || d.content !== saved.content;
      })
    );
  },
  resetDraft(key: WebviewConfigFieldKey) {
    setState(
      produce((s) => {
        const saved = s.configFields[key];
        s.configDrafts[key] = { inherit: saved.inherit, content: saved.content, dirty: false };
      })
    );
  },
  saveDraft(key: WebviewConfigFieldKey) {
    const d = state.configDrafts[key];
    post({ type: 'saveConfigField', field: key, inherit: d.inherit, content: d.content });
    setState(
      produce((s) => {
        s.configFields[key].inherit = d.inherit;
        s.configFields[key].content = d.content;
        s.configDrafts[key].dirty = false;
      })
    );
  },
  addAttachments(items: PendingAttachment[]) {
    setState('pendingAttachments', (cur) => [...cur, ...items]);
  },
  removeAttachment(id: string) {
    setState('pendingAttachments', (cur) => cur.filter((x) => x.id !== id));
  },
  clearAttachments() {
    setState('pendingAttachments', []);
  },
  addLargeEditorAttachments(items: PendingAttachment[]) {
    setState('largeEditorAttachments', (cur) => [...cur, ...items]);
  },
  removeLargeEditorAttachment(id: string) {
    setState('largeEditorAttachments', (cur) => cur.filter((x) => x.id !== id));
  },
  clearLargeEditorAttachments() {
    setState('largeEditorAttachments', []);
  },
  async persistLargeEditorAttachments(): Promise<
    { ok: boolean; attachments?: ChatAttachment[]; error?: string }
  > {
    const items = state.largeEditorAttachments;
    if (items.length === 0) return { ok: true, attachments: [] };
    const requestId = createRequestId();
    return new Promise((resolve) => {
      editorAttachmentResolvers.set(requestId, resolve);
      post({
        type: 'persistEditorAttachments',
        requestId,
        attachments: items.map((a) => ({
          name: a.name,
          mimeType: a.mimeType,
          size: a.size,
          dataUrl: a.dataUrl
        }))
      });
    });
  },
  startEditing(id: string, content: string, mode: 'correct' | 'rewrite-branch' = 'correct') {
    setState(
      produce((s) => {
        s.editingMessageId = id;
        s.editingMode = mode;
        s.editDraft = content;
        s.largeEditorAttachments = [];
        // Open the shared large editor directly (no inline small box).
        s.largeEditor = {
          mode: mode === 'rewrite-branch' ? 'edit-rewrite' : 'edit-correct',
          value: content
        };
        s.largeEditorSeedNonce += 1;
      })
    );
    // Existing markdown asset references in the original content are imported
    // as thumbnails (same UX as the composer) so the textarea shows only the
    // surrounding text.
    if (hasLocalMarkdownAssetReference(content)) {
      void actions.importClipboardMarkdown(content).then((result) => {
        if (state.editingMessageId !== id) return;
        if (!result.ok) return;
        const strippedText = typeof result.text === 'string' ? result.text : content;
        const items = (result.attachments ?? []).map((a, i) => ({
          id: `existing-${Date.now()}-${i}`,
          name: a.name ?? `image-${i}`,
          mimeType: a.mimeType ?? 'application/octet-stream',
          size: a.size ?? 0,
          dataUrl: a.dataUrl,
          kind: ((a.mimeType ?? '').toLowerCase().startsWith('image/') ? 'image' : 'file') as
            | 'image'
            | 'file'
        }));
        setState(
          produce((s) => {
            s.editDraft = strippedText;
            if (s.largeEditor && s.largeEditor.mode !== 'composer') {
              s.largeEditor.value = strippedText;
            }
            s.largeEditorAttachments = items;
            s.largeEditorSeedNonce += 1;
          })
        );
      });
    }
  },
  cancelEditing() {
    setState(
      produce((s) => {
        s.editingMessageId = null;
        s.editDraft = '';
        s.largeEditorAttachments = [];
        // also close the large editor if it was driving an edit
        if (s.largeEditor && s.largeEditor.mode !== 'composer') s.largeEditor = null;
      })
    );
  },
  setEditDraft(v: string) {
    setState('editDraft', v);
  },
  submitEdit(continueGeneration?: boolean) {
    const id = state.editingMessageId;
    if (!id) return;
    const content = state.editDraft;
    if (state.editingMode === 'rewrite-branch') {
      post({ type: 'rewriteMessageBranch', messageId: id, content, continueGeneration });
    } else {
      post({ type: 'editMessage', messageId: id, content });
    }
    actions.cancelEditing();
  },
  openLargeEditor(mode: 'composer' | 'edit-correct' | 'edit-rewrite', value: string) {
    setState(
      produce((s) => {
        s.largeEditor = { mode, value };
        s.largeEditorSeedNonce += 1;
      })
    );
  },
  setLargeEditorValue(v: string) {
    setState(
      produce((s) => {
        if (s.largeEditor) s.largeEditor.value = v;
      })
    );
  },
  closeLargeEditor() {
    setState('largeEditor', null);
  },
  clearComposerExternalValue() {
    setState('composerExternalValue', null);
  },
  async applyLargeEditor(continueGeneration?: boolean) {
    const le = state.largeEditor;
    if (!le) return;
    const value = le.value;
    if (le.mode === 'composer') {
      setState('composerExternalValue', { value, nonce: Date.now() });
      setState('largeEditor', null);
      return;
    }
    // edit modes: persist any newly added attachments and stitch markdown refs into content
    let finalValue = value;
    if (state.largeEditorAttachments.length > 0) {
      const result = await actions.persistLargeEditorAttachments();
      if (!result.ok) {
        setState('error', result.error || t('editor.saveAttachmentFailed'));
        return;
      }
      const links = (result.attachments ?? [])
        .map((a) => {
          const label = (a.originalName || a.assetPath)
            .replace(/[\r\n\[\]]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || 'attachment';
          return a.kind === 'image' ? `![${label}](${a.assetPath})` : `[${label}](${a.assetPath})`;
        })
        .join('\n');
      if (links) {
        const sep = finalValue.length === 0 || finalValue.endsWith('\n') ? '' : '\n\n';
        finalValue = `${finalValue}${sep}${links}`;
      }
      actions.clearLargeEditorAttachments();
    }
    setState('editDraft', finalValue);
    setState('largeEditor', null);
    actions.submitEdit(continueGeneration);
  },
  toggleReasoning(id: string, open?: boolean) {
    setState('reasoningOpen', id, (v) => (typeof open === 'boolean' ? open : !v));
  },
  toggleVersionPanel(id: string, open?: boolean) {
    setState('versionPanelOpen', id, (v) => (typeof open === 'boolean' ? open : !v));
  },
  previewVersion(messageId: string, versionId: string) {
    setState('previewVersionId', messageId, versionId);
  },
  clearPreviewVersion(messageId: string) {
    setState(
      produce((s) => {
        delete s.previewVersionId[messageId];
      })
    );
  },
  toggleCodeBlock(key: string) {
    setState('codeBlockCollapsed', key, (v) => !v);
  },
  setCodeBlockCopyFeedback(key: string, label: string) {
    setState('codeBlockCopyFeedback', key, label);
    if (label) {
      window.setTimeout(() => {
        if (state.codeBlockCopyFeedback[key] === label) {
          setState(
            produce((s) => {
              delete s.codeBlockCopyFeedback[key];
            })
          );
        }
      }, 1600);
    }
  },
  openImagePreview(src: string, alt?: string, relativePath?: string, role?: string) {
    setState('activeImagePreview', { src, alt, relativePath, role });
  },
  closeImagePreview() {
    setState(
      produce((s) => {
        s.activeImagePreview = null;
        s.imagePreviewCopyFeedback = '';
        s.isCopyingImagePreview = false;
      })
    );
  },
  setMessagePreviewOpen(open: boolean) {
    setState('isMessagePreviewOpen', open);
  },
  setActivePreviewMessageId(id: string | null) {
    setState('activePreviewMessageId', id);
  },
  async sendPrompt(prompt: string, attachments: WebviewIncomingAttachment[]): Promise<boolean> {
    const requestId = createRequestId();
    const submission: PendingSubmission = { requestId, prompt, attachments };
    setState('pendingSubmission', submission);
    const ok = await new Promise<boolean>((resolve) => {
      sendPromptResolvers.set(requestId, resolve);
      post({ type: 'sendPrompt', requestId, prompt, attachments });
    });
    setState('pendingSubmission', null);
    return ok;
  },
  stopGeneration() {
    post({ type: 'stopGeneration' });
  },
  copyMessage(id: string) {
    post({ type: 'copyMessage', messageId: id });
  },
  copyMessageVersion(id: string, versionId: string) {
    post({ type: 'copyMessageVersion', messageId: id, versionId });
  },
  copyCodeBlock(content: string) {
    post({ type: 'copyCodeBlock', content });
  },
  restoreVersion(id: string, versionId: string) {
    post({ type: 'restoreMessageVersion', messageId: id, versionId });
  },
  deleteVersion(id: string, versionId: string) {
    post({ type: 'deleteMessageVersion', messageId: id, versionId });
  },
  deleteBranch(id: string) {
    post({ type: 'deleteMessageBranch', messageId: id });
  },
  resend(id: string) {
    post({ type: 'resendMessage', messageId: id });
  },
  selectSibling(id: string, direction: 'previous' | 'next') {
    post({ type: 'selectSibling', messageId: id, direction });
  },
  branchMessage(id: string) {
    post({ type: 'branchMessage', messageId: id });
  },
  manageProviderConfig() {
    post({ type: 'manageProviderConfig' });
  },
  manageCommonConfig() {
    post({ type: 'manageCommonConfig' });
  },
  viewRawChatJson() {
    post({ type: 'viewRawChatJson' });
  },
  openExternalLink(href: string) {
    post({ type: 'openExternalLink', href });
  },
  createNewChat() {
    post({ type: 'createNewChat' });
  },
  async importClipboardMarkdown(text: string) {
    const requestId = createRequestId();
    return await new Promise<{
      ok: boolean;
      text?: string;
      attachments?: WebviewIncomingAttachment[];
      error?: string;
    }>((resolve) => {
      clipboardResolvers.set(requestId, resolve);
      post({ type: 'importClipboardMarkdownAttachments', requestId, text });
    });
  }
};

// Layout signal for the compact viewport (mirrors window.matchMedia)
const compactMedia = window.matchMedia('(max-width: 960px)');
export const [isCompact, setCompact] = createSignal(compactMedia.matches);
compactMedia.addEventListener('change', (e) => setCompact(e.matches));
