// Shared message protocol between extension host and webview.
// Both sides import from here; do not depend on vscode or DOM here.

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatMessageStatus = 'pending' | 'completed' | 'error' | 'canceled';

export type ChatMessageBodyPart =
  | { type: 'text'; text: string }
  | { type: 'attachment_ref'; attachmentId: string };

export interface ChatMessageBody {
  parts: ChatMessageBodyPart[];
}

export interface ChatAttachment {
  id: string;
  kind: 'image' | 'file';
  assetPath: string;
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
}

export interface ChatTokenStats {
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export type WebviewChatContentPart =
  | { type: 'text'; html?: string; text: string }
  | { type: 'image'; alt: string; attachmentId: string; relativePath: string; src: string }
  | { type: 'file'; attachmentId: string; label: string; detail: string; relativePath: string };

export interface ChatMessageVersion {
  id: string;
  content: string;
  body: ChatMessageBody;
  attachments?: ChatAttachment[];
  savedAt: string;
  reasoningContent?: string;
  thinkingDurationMs?: number;
  totalDurationMs?: number;
  tokenStats?: ChatTokenStats;
  model?: string;
  providerId?: string;
  optionId?: string;
  assistantLabel?: string;
  // Webview-projected:
  contentHtml?: string;
  contentParts?: WebviewChatContentPart[];
  reasoningContentHtml?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  body: ChatMessageBody;
  attachments?: ChatAttachment[];
  currentVersionId?: string;
  versions?: ChatMessageVersion[];
  createdAt: string;
  parentId?: string;
  childIds?: string[];
  model?: string;
  providerId?: string;
  optionId?: string;
  reasoningContent?: string;
  thinkingDurationMs?: number;
  totalDurationMs?: number;
  tokenStats?: ChatTokenStats;
  status?: ChatMessageStatus;
  errorDetail?: string;
  // Webview-projected:
  contentHtml?: string;
  contentParts?: WebviewChatContentPart[];
  reasoningContentHtml?: string;
  branchIndex?: number;
  branchCount?: number;
  hasPreviousSibling?: boolean;
  hasNextSibling?: boolean;
  isLastMessage?: boolean;
}

export interface WebviewChatFile {
  id?: string;
  title?: string;
  messages: ChatMessage[];
  rootMessageIds?: string[];
  activeChildByParentId?: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
}

// --- provider/model selection ---
export interface WebviewProviderOptionItem { id: string; label: string }
export interface WebviewProviderModelItem { id: string; label: string; options: WebviewProviderOptionItem[] }
export interface WebviewProviderItem { id: string; label: string; models: WebviewProviderModelItem[] }
export interface ChatModelSelection { providerId?: string; modelId?: string; optionId?: string }

// --- common config / inheritable fields ---
export type WebviewConfigFieldKey = 'systemPrompt' | 'messageTemplate';
export type WebviewConfigFieldSource = 'common-config' | 'local' | 'none';
export interface WebviewConfigFieldState {
  inherit: boolean;
  content: string;
  effectiveContent: string;
  source: WebviewConfigFieldSource;
  inheritedConfigId?: string;
  inheritedConfigName?: string;
  missingInheritedConfig: boolean;
  missingInheritedValue: boolean;
  hasRetainedDraft: boolean;
}
export interface WebviewCommonConfigOptionItem {
  id: string;
  name: string;
  systemPrompt: string;
  messageTemplate: string;
}
export interface WebviewCommonConfigState {
  selectedId?: string;
  selectedName?: string;
  hasMissingSelection: boolean;
  options: WebviewCommonConfigOptionItem[];
}

export interface WebviewDocumentState {
  error?: string;
  fileName: string;
  isBusy: boolean;
  availableProviders: WebviewProviderItem[];
  currentSelection?: ChatModelSelection;
  canSend: boolean;
  commonConfig: WebviewCommonConfigState;
  systemPrompt: WebviewConfigFieldState;
  messageTemplate: WebviewConfigFieldState;
}

// --- attachments (in-flight upload from webview) ---
export interface WebviewIncomingAttachment {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

// ===== host -> webview =====
export type HostToWebviewMessage =
  | { type: 'document'; value: WebviewChatFile; state: WebviewDocumentState }
  | {
      type: 'streamChunk';
      messageId: string;
      contentDelta?: string;
      reasoningDelta?: string;
      content?: string;
      reasoningContent?: string;
      contentHtml?: string;
      reasoningContentHtml?: string;
    }
  | { type: 'sendPromptResult'; requestId: string; ok: boolean }
  | {
      type: 'clipboardMarkdownAttachments';
      requestId: string;
      ok: boolean;
      text?: string;
      attachments?: WebviewIncomingAttachment[];
      error?: string;
    }
  | {
      type: 'editorAttachmentsPersisted';
      requestId: string;
      ok: boolean;
      attachments?: ChatAttachment[];
      error?: string;
    };

// ===== webview -> host =====
export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'updateModelSelection'; providerId: string; modelId: string; optionId?: string }
  | { type: 'updateCommonConfigId'; commonConfigId?: string | null }
  | { type: 'saveConfigField'; field: WebviewConfigFieldKey; inherit: boolean; content?: string | null }
  | { type: 'sendPrompt'; requestId?: string; prompt: string; attachments?: WebviewIncomingAttachment[] }
  | { type: 'stopGeneration' }
  | { type: 'copyMessage'; messageId: string }
  | { type: 'copyMessageVersion'; messageId: string; versionId: string }
  | { type: 'copyCodeBlock'; content: string }
  | { type: 'importClipboardMarkdownAttachments'; requestId: string; text: string }
  | { type: 'persistEditorAttachments'; requestId: string; attachments: WebviewIncomingAttachment[] }
  | { type: 'editMessage'; messageId: string; content: string }
  | { type: 'restoreMessageVersion'; messageId: string; versionId: string }
  | { type: 'deleteMessageVersion'; messageId: string; versionId: string }
  | { type: 'deleteMessageBranch'; messageId: string }
  | { type: 'rewriteMessageBranch'; messageId: string; content: string; continueGeneration?: boolean }
  | { type: 'resendMessage'; messageId: string }
  | { type: 'selectSibling'; messageId: string; direction: 'previous' | 'next' }
  | { type: 'branchMessage'; messageId: string }
  | { type: 'manageProviderConfig' }
  | { type: 'manageCommonConfig' }
  | { type: 'viewRawChatJson' }
  | { type: 'openExternalLink'; href: string }
  | { type: 'createNewChat' };
