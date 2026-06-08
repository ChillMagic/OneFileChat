import * as vscode from 'vscode';
import { t } from '../../shared/i18n';
import type {
  ChatAttachment,
  ChatMessage,
  ChatMessageVersion,
  ChatTokenStats
} from '../../shared/protocol';

export type {
  ChatAttachment,
  ChatMessage,
  ChatMessageBody,
  ChatMessageBodyPart,
  ChatMessageStatus,
  ChatMessageVersion,
  ChatRole,
  ChatTokenStats,
  HostToWebviewMessage,
  WebviewChatContentPart,
  WebviewChatFile,
  WebviewCommonConfigState,
  WebviewConfigFieldSource,
  WebviewConfigFieldState,
  WebviewIncomingAttachment,
  WebviewProviderItem,
  WebviewToHostMessage
} from '../../shared/protocol';

export const VIEW_TYPE = 'onefilechat.chatEditor';

export type IsTextFileFunction = (filename?: string | null, buffer?: Buffer | null) => boolean | null;

export const ROOT_BRANCH_PARENT_ID = '__root__';

export const CHAT_DIRECTORY_NAME = '.filechat';

export const CHAT_ASSETS_DIRECTORY_NAME = 'assets';

export const CHAT_COMMON_CONFIGS_FILE_NAME = 'common_configs.json';

export const CHAT_FILE_EXTENSION = '.filechat.json';

export const CHAT_FILE_GLOB = `**/*${CHAT_FILE_EXTENSION}`;

export const CHAT_DATA_DIRECTORY_GLOB = `**/${CHAT_DIRECTORY_NAME}`;

export const CHAT_FILE_VERSION = 1;

export const DEFAULT_CHAT_TITLE = () => t('defaults.newChatTitle');

export const CHAT_TITLE_MAX_LENGTH = 36;

export const TITLE_GENERATION_REQUEST_TIMEOUT_MS = 25_000;

export const TITLE_GENERATION_MAX_CONTEXT_MESSAGES = 4;

export const TITLE_GENERATION_MAX_CONTEXT_CHARS = 900;

export const TITLE_GENERATION_MAX_CONTEXT_LINE_CHARS = 180;

export const TITLE_GENERATION_SYSTEM_PROMPT = () => t('host.titleGenerationSystemPrompt');

export const SESSIONS_VIEW_VISIBILITY_CONTEXT = 'onefilechat.hasWorkspaceChatResources';

export const KEY_FILE_ENV_VAR_REGEX = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

export const ASSISTANT_IMAGE_FETCH_TIMEOUT_MS = 15_000;

export const GENERIC_BINARY_MIME_TYPE = 'application/octet-stream';

export const SUPPORTED_IMAGE_MIME_TYPES = new Map<string, string>([
  ['image/gif', 'gif'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);

export type PersistedChatMessageVersion =
  | Omit<ChatMessageVersion, 'body' | 'attachments'>
  | Omit<ChatMessageVersion, 'content'>;

export type ChatAttachmentKind = ChatAttachment['kind'];

export type PersistedChatMessage = Omit<
  ChatMessage,
  | 'content'
  | 'body'
  | 'attachments'
  | 'childIds'
  | 'reasoningContent'
  | 'thinkingDurationMs'
  | 'totalDurationMs'
  | 'tokenStats'
  | 'model'
  | 'providerId'
  | 'optionId'
  | 'versions'
> & { versions?: PersistedChatMessageVersion[] };

export interface PersistedChatModelSelectionJSON {
  model?: string;
  providerId?: string;
  optionId?: string;
}

export interface StreamSnapshot {
  messageId: string;
  content: string;
  reasoningContent: string;
}

export interface EditorStreamData {
  flush: () => void;
  queue: Promise<void>;
  latestSnapshot?: StreamSnapshot;
}

export interface PersistedChatFile extends Omit<ChatFile, 'messages' | 'modelSelection'> {
  messages: PersistedChatMessage[];
  modelSelection?: PersistedChatModelSelectionJSON;
}

export interface InheritableTextField {
  inherit: boolean;
  content: string | null;
}

export interface ChatFile {
  version: 1;
  title: string;
  createdAt: string;
  updatedAt: string;
  rootMessageIds: string[];
  activeChildByParentId: Record<string, string>;
  messages: ChatMessage[];
  commonConfigId?: string | null;
  systemPrompt?: InheritableTextField;
  messageTemplate?: InheritableTextField;
  modelSelection?: ChatModelSelection;
}

export interface ChatSessionSummary {
  kind: 'session';
  uri: vscode.Uri;
  title: string;
  createdAt: string;
  updatedAt: string;
  assistantName?: string;
  messageCount: number;
  preview: string;
  relativePath: string;
  directoryPath: string;
  directorySegments: string[];
  workspaceFolderKey: string;
  workspaceFolderName?: string;
  hasError: boolean;
  error?: string;
}

export interface ChatSessionFolderNode {
  kind: 'folder';
  id: string;
  label: string;
  relativePath: string;
  uri: vscode.Uri;
  children: ChatSessionTreeNode[];
  childrenLoaded?: boolean;
}

export type ChatSessionTreeNode = ChatSessionFolderNode | ChatSessionSummary;

export interface KeyFileOptionConfig {
  id: string;
  label: string;
  config?: Record<string, unknown>;
}

export interface KeyFileModelConfig {
  id: string;
  label: string;
  options?: KeyFileOptionConfig[];
}

export interface KeyFileProviderConfig {
  label: string;
  transport: 'openai-compatible';
  api_key: string;
  api_base?: string;
  models: KeyFileModelConfig[];
}

export interface KeyFileTitleGenerationConfig {
  selection?: ChatModelSelection;
  selectionError?: string;
}

export interface KeyFileConfig {
  providers: Record<string, KeyFileProviderConfig>;
  titleGeneration?: KeyFileTitleGenerationConfig;
}

export interface ChatDataDirectoryResolution {
  candidateBaseDirectories: vscode.Uri[];
  preferredCreateBaseDirectory: vscode.Uri;
}

export interface CommonConfigEntry {
  name: string;
  system_prompt: string;
  message_template: string;
}

export type CommonConfigsFile = Record<string, CommonConfigEntry>;

export interface ChatModelSelection {
  providerId?: string;
  modelId?: string;
  optionId?: string;
}

export interface ResolvedModelConfig {
  providerId: string;
  providerLabel: string;
  transport: 'openai-compatible';
  api_key: string;
  api_base?: string;
  model: string;
  modelLabel: string;
  optionId?: string;
  optionLabel?: string;
  assistantLabel: string;
  extraRequestConfig: Record<string, unknown>;
}

export interface ResolveTitleGenerationRequestConfigOptions {
  fallbackConfig?: ResolvedModelConfig;
  allowInvalidCustomSelectionFallback?: boolean;
}

export interface AssistantResponse {
  content: string;
  reasoningContent?: string;
  thinkingDurationMs: number;
  totalDurationMs: number;
  tokenStats?: ChatTokenStats;
}

export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;

    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await work();
    } finally {
      release();
    }
  }
}
