import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import hljs from 'highlight.js/lib/common';
import { parse as parseJsonc, ParseError, printParseErrorCode } from 'jsonc-parser/lib/esm/main.js';
import MarkdownIt from 'markdown-it';
import { extension as getMimeExtension, lookup as lookupMimeType } from 'mime-types';
import OpenAI from 'openai';
import { applyLegacyChatCompatibility } from './chatCompat';
import { createModelTextForParsedFileAttachment } from './parsers/files';
import { setLocale, normalizeLocale, t, getLocale } from './shared/i18n';
import {
  type ChatAttachment,
  type ChatMessage,
  type ChatMessageBody,
  type ChatMessageBodyPart,
  type ChatMessageStatus,
  type ChatMessageVersion,
  type ChatRole,
  type ChatTokenStats,
  type WebviewChatContentPart,
  type WebviewChatFile,
  type WebviewCommonConfigState,
  type WebviewConfigFieldSource,
  type WebviewConfigFieldState,
  type WebviewIncomingAttachment,
  type WebviewProviderItem,
  type HostToWebviewMessage,
  type WebviewToHostMessage
} from './shared/protocol';

const katex = require('katex');
const texmath = require('markdown-it-texmath');

const VIEW_TYPE = 'onefilechat.chatEditor';
const MARKDOWN_LINK_SCHEMES = new Set(['http', 'https', 'mailto']);
const markdownRenderer = createMarkdownRenderer();

type IsTextFileFunction = (filename?: string | null, buffer?: Buffer | null) => boolean | null;
const ROOT_BRANCH_PARENT_ID = '__root__';
const CHAT_DIRECTORY_NAME = '.filechat';
const CHAT_ASSETS_DIRECTORY_NAME = 'assets';
const CHAT_COMMON_CONFIGS_FILE_NAME = 'common_configs.json';
const CHAT_FILE_EXTENSION = '.filechat.json';
const CHAT_FILE_GLOB = `**/*${CHAT_FILE_EXTENSION}`;
const CHAT_DATA_DIRECTORY_GLOB = `**/${CHAT_DIRECTORY_NAME}`;
const CHAT_FILE_VERSION = 1;
const DEFAULT_CHAT_TITLE = () => t('defaults.newChatTitle');
const CHAT_TITLE_MAX_LENGTH = 36;
const TITLE_GENERATION_REQUEST_TIMEOUT_MS = 25_000;
const TITLE_GENERATION_MAX_CONTEXT_MESSAGES = 4;
const TITLE_GENERATION_MAX_CONTEXT_CHARS = 900;
const TITLE_GENERATION_MAX_CONTEXT_LINE_CHARS = 180;
const TITLE_GENERATION_SYSTEM_PROMPT = () => t('host.titleGenerationSystemPrompt');
const SESSIONS_VIEW_VISIBILITY_CONTEXT = 'onefilechat.hasWorkspaceChatResources';
const KEY_FILE_ENV_VAR_REGEX = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ASSISTANT_IMAGE_FETCH_TIMEOUT_MS = 15_000;
const GENERIC_BINARY_MIME_TYPE = 'application/octet-stream';
const SUPPORTED_IMAGE_MIME_TYPES = new Map<string, string>([
  ['image/gif', 'gif'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);
let isTextFileLoader: Promise<IsTextFileFunction> | undefined;

type PersistedChatMessageVersion =
  | Omit<ChatMessageVersion, 'body' | 'attachments'>
  | Omit<ChatMessageVersion, 'content'>;

type ChatAttachmentKind = ChatAttachment['kind'];

type PersistedChatMessage = Omit<
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

interface PersistedChatModelSelectionJSON {
  model?: string;
  providerId?: string;
  optionId?: string;
}

interface StreamSnapshot {
  messageId: string;
  content: string;
  reasoningContent: string;
}

interface EditorStreamData {
  flush: () => void;
  queue: Promise<void>;
  latestSnapshot?: StreamSnapshot;
}

interface PersistedChatFile extends Omit<ChatFile, 'messages' | 'modelSelection'> {
  messages: PersistedChatMessage[];
  modelSelection?: PersistedChatModelSelectionJSON;
}

interface InheritableTextField {
  inherit: boolean;
  content: string | null;
}

interface ChatFile {
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

interface ChatSessionSummary {
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

interface ChatSessionFolderNode {
  kind: 'folder';
  id: string;
  label: string;
  relativePath: string;
  children: ChatSessionTreeNode[];
}

type ChatSessionTreeNode = ChatSessionFolderNode | ChatSessionSummary;

interface KeyFileOptionConfig {
  id: string;
  label: string;
  config?: Record<string, unknown>;
}

interface KeyFileModelConfig {
  id: string;
  label: string;
  options?: KeyFileOptionConfig[];
}

interface KeyFileProviderConfig {
  label: string;
  transport: 'openai-compatible';
  api_key: string;
  api_base?: string;
  models: KeyFileModelConfig[];
}

interface KeyFileTitleGenerationConfig {
  selection?: ChatModelSelection;
  selectionError?: string;
}

interface KeyFileConfig {
  providers: Record<string, KeyFileProviderConfig>;
  titleGeneration?: KeyFileTitleGenerationConfig;
}

interface ChatDataDirectoryResolution {
  candidateBaseDirectories: vscode.Uri[];
  preferredCreateBaseDirectory: vscode.Uri;
}

interface CommonConfigEntry {
  name: string;
  system_prompt: string;
  message_template: string;
}

type CommonConfigsFile = Record<string, CommonConfigEntry>;

interface ChatModelSelection {
  providerId?: string;
  modelId?: string;
  optionId?: string;
}

interface ResolvedModelConfig {
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

interface ResolveTitleGenerationRequestConfigOptions {
  fallbackConfig?: ResolvedModelConfig;
  allowInvalidCustomSelectionFallback?: boolean;
}

interface AssistantResponse {
  content: string;
  reasoningContent?: string;
  thinkingDurationMs: number;
  totalDurationMs: number;
  tokenStats?: ChatTokenStats;
}



const UNSUPPORTED_KEY_FILE_FIELDS = new Set([
  'provider',
  'apiKey',
  'apiKeyEnvName',
  'baseUrl',
  'baseURL',
  'base_url',
  'assistant_name',
  'aiName',
  'reasoningEffort',
  'thinking',
  'request'
]);

class AsyncMutex {
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

export function activate(context: vscode.ExtensionContext): void {
  setLocale(normalizeLocale(vscode.env.language));
  const provider = new OneFileChatEditorProvider(context);
  const sessionsProvider = new ChatSessionsProvider();
  void vscode.commands.executeCommand('setContext', SESSIONS_VIEW_VISIBILITY_CONTEXT, false);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  queueMicrotask(() => {
    void reopenActiveChatTextEditorIfNeeded();
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.newChatFile', async () => {
      await createNewChatFile(getActiveChatEditorDocumentUri());
    })
  );

  const sessionsTreeView = vscode.window.createTreeView<ChatSessionTreeNode>('onefilechat.sessionsView', {
    treeDataProvider: sessionsProvider,
    canSelectMany: true,
    showCollapseAll: true
  });
  context.subscriptions.push(sessionsTreeView);

  let pendingSessionPreviewOpen: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    sessionsTreeView.onDidChangeSelection((event) => {
      if (pendingSessionPreviewOpen !== undefined) {
        clearTimeout(pendingSessionPreviewOpen);
        pendingSessionPreviewOpen = undefined;
      }

      if (event.selection.length !== 1) {
        return;
      }

      const selectedItem = event.selection[0];
      if (selectedItem.kind !== 'session') {
        return;
      }

      const targetSessionUri = selectedItem.uri;
      pendingSessionPreviewOpen = setTimeout(() => {
        pendingSessionPreviewOpen = undefined;

        if (sessionsTreeView.selection.length !== 1) {
          return;
        }

        const currentSelection = sessionsTreeView.selection[0];
        if (currentSelection.kind !== 'session' || currentSelection.uri.toString() !== targetSessionUri.toString()) {
          return;
        }

        void vscode.commands.executeCommand('vscode.openWith', targetSessionUri, VIEW_TYPE, {
          preview: true,
          preserveFocus: true
        });
      }, 120);
    })
  );
  context.subscriptions.push({
    dispose: () => {
      if (pendingSessionPreviewOpen !== undefined) {
        clearTimeout(pendingSessionPreviewOpen);
      }
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.refreshSessions', async () => {
      await sessionsProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.renameChatTitle', async (item?: ChatSessionSummary, selectedItems?: readonly ChatSessionTreeNode[]) => {
      const targetUri = resolveSingleSessionCommandTargetUri(item, selectedItems, t('host.noChatToRename'));
      if (!targetUri) {
        return;
      }

      try {
        await renameChatTitle(targetUri);
        await sessionsProvider.upsertSession(targetUri);
      } catch (error) {
        const message = toErrorMessage(error);
        void vscode.window.showErrorMessage(message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.regenerateChatTitle', async (item?: ChatSessionSummary, selectedItems?: readonly ChatSessionTreeNode[]) => {
      const targetUri = resolveSingleSessionCommandTargetUri(item, selectedItems, t('host.noChatToRegenerateTitle'));
      if (!targetUri) {
        return;
      }

      try {
        const didChange = await regenerateChatTitle(targetUri);
        if (!didChange) {
          void vscode.window.showInformationMessage(t('host.titleSameAsCurrentInfo'));
          return;
        }

        await sessionsProvider.upsertSession(targetUri);
      } catch (error) {
        const message = toErrorMessage(error);
        void vscode.window.showErrorMessage(message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.deleteChatSession', async (item?: ChatSessionSummary, selectedItems?: readonly ChatSessionTreeNode[]) => {
      try {
        const targets = await resolveDeleteChatSessionTargets(item, selectedItems, sessionsTreeView.selection, sessionsProvider);
        if (targets.length === 0) {
          void vscode.window.showInformationMessage(t('host.noChatToDelete'));
          return;
        }

        const confirmed = await confirmDeleteChatSessions(targets);
        if (!confirmed) {
          return;
        }

        await closeChatEditors(targets.map((target) => target.uri));
        for (const target of targets) {
          await vscode.workspace.fs.delete(target.uri, { useTrash: false });
        }

        await sessionsProvider.refresh();
      } catch (error) {
        const message = toErrorMessage(error);
        void vscode.window.showErrorMessage(message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.manageProviderConfig', async (resourceUri?: vscode.Uri) => {
      await manageProviderConfigCommand(resourceUri);
      await sessionsProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.manageCommonConfig', async (resourceUri?: vscode.Uri) => {
      await manageCommonConfigCommand(resourceUri);
      await sessionsProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('onefilechat.viewRawChatJson', async (item?: ChatSessionSummary | vscode.Uri) => {
      const target = resolveRawJsonTargetUri(item);
      if (!target) {
        void vscode.window.showWarningMessage(t('host.noChatFileToView'));
        return;
      }
      try {
        const document = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      } catch (error) {
        void vscode.window.showErrorMessage(toErrorMessage(error));
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void sessionsProvider.refresh();
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher(CHAT_FILE_GLOB);
  const chatDirectoryWatcher = vscode.workspace.createFileSystemWatcher(CHAT_DATA_DIRECTORY_GLOB);
  const refreshSessions = () => {
    void sessionsProvider.refresh();
  };
  const upsertSession = (uri: vscode.Uri) => {
    void sessionsProvider.upsertSession(uri);
  };
  const removeSession = (uri: vscode.Uri) => {
    void sessionsProvider.removeSession(uri);
  };
  context.subscriptions.push(watcher);
  context.subscriptions.push(chatDirectoryWatcher);
  context.subscriptions.push(watcher.onDidCreate(upsertSession));
  context.subscriptions.push(watcher.onDidChange(upsertSession));
  context.subscriptions.push(watcher.onDidDelete(removeSession));
  context.subscriptions.push(chatDirectoryWatcher.onDidCreate(refreshSessions));
  context.subscriptions.push(chatDirectoryWatcher.onDidDelete(refreshSessions));

  void sessionsProvider.refresh();
}

export function deactivate(): void {}

class ChatSessionsProvider implements vscode.TreeDataProvider<ChatSessionTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<ChatSessionTreeNode | undefined | null | void>();
  private rootNodes: ChatSessionTreeNode[] = [];

  readonly onDidChangeTreeData = this.changeEmitter.event;

  getTreeItem(element: ChatSessionTreeNode): vscode.TreeItem {
    if (element.kind === 'folder') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = element.id;
      item.contextValue = 'onefilechatFolder';
      item.iconPath = new vscode.ThemeIcon('folder');
      item.tooltip = element.relativePath || element.label;
      return item;
    }

    const item = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.None);
    item.id = element.uri.toString();
    item.contextValue = 'onefilechatSession';
    item.description = formatSessionUpdatedAt(element.updatedAt);
    item.iconPath = new vscode.ThemeIcon(element.hasError ? 'warning' : 'comment-discussion');
    item.tooltip = createSessionTooltip(element);
    return item;
  }

  getChildren(element?: ChatSessionTreeNode): ChatSessionTreeNode[] {
    if (element) {
      return element.kind === 'folder' ? element.children : [];
    }

    return this.rootNodes;
  }

  async refresh(): Promise<void> {
    const summaries = await loadChatSessionSummaries();
    await this.setSessions(summaries);
  }

  async upsertSession(uri: vscode.Uri): Promise<void> {
    const nextSessions = this.getAllSessions().filter((session) => session.uri.toString() !== uri.toString());
    nextSessions.push(await createChatSessionSummary(uri));
    await this.setSessions(nextSessions);
  }

  async removeSession(uri: vscode.Uri): Promise<void> {
    const nextSessions = this.getAllSessions().filter((session) => session.uri.toString() !== uri.toString());
    await this.setSessions(nextSessions);
  }

  getSessionByUri(uri: vscode.Uri): ChatSessionSummary | undefined {
    const sessionId = uri.toString();
    return this.getAllSessions().find((session) => session.uri.toString() === sessionId);
  }

  private getAllSessions(): ChatSessionSummary[] {
    const sessions: ChatSessionSummary[] = [];
    const visit = (nodes: readonly ChatSessionTreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === 'session') {
          sessions.push(node);
          continue;
        }

        visit(node.children);
      }
    };

    visit(this.rootNodes);
    return sessions;
  }

  private async setSessions(summaries: ChatSessionSummary[]): Promise<void> {
    this.rootNodes = buildChatSessionTree(summaries);
    await setSessionsViewVisibilityContext(summaries.length > 0 || await hasAnyChatDataDirectoryInWorkspace());
    this.changeEmitter.fire();
  }
}

async function createNewChatFile(resourceUri?: vscode.Uri): Promise<void> {
  const baseDirectoryUri = getPreferredNewChatBaseDirectoryUri(resourceUri);
  const targetUri = await createUniqueChatFileUri(baseDirectoryUri);
  const untitledUri = createUntitledChatFileUri(targetUri);
  const initialContent = serializeChatFile(createEmptyChatFile(DEFAULT_CHAT_TITLE()));
  const document = await vscode.workspace.openTextDocument(untitledUri);

  if (document.getText() !== initialContent) {
    await replaceDocumentContent(document, initialContent);
  }

  await vscode.commands.executeCommand('vscode.openWith', untitledUri, VIEW_TYPE);
}

async function manageProviderConfigCommand(resourceUri?: vscode.Uri): Promise<void> {
  const resolution = await resolveChatDataDirectoryResolution(resourceUri);
  const existingKeyUri = await findFirstExistingUri(getChatDataFileCandidateUris(resolution, 'key.json'));
  const keyUri = existingKeyUri ?? getKeyFileUriForDirectory(resolution.preferredCreateBaseDirectory);

  if (!existingKeyUri) {
    await vscode.workspace.fs.createDirectory(getChatDataDirectoryUriForBaseDirectory(resolution.preferredCreateBaseDirectory));

    try {
      await vscode.workspace.fs.stat(keyUri);
    } catch {
      await vscode.workspace.fs.writeFile(keyUri, Buffer.from(createDefaultKeyFileContent(), 'utf8'));
    }
  }

  const keyDocument = await vscode.workspace.openTextDocument(keyUri);
  await vscode.window.showTextDocument(keyDocument, { preview: false });
}

async function manageCommonConfigCommand(resourceUri?: vscode.Uri): Promise<void> {
  const resolution = await resolveChatDataDirectoryResolution(resourceUri);
  const existingConfigUri = await findFirstExistingUri(getChatDataFileCandidateUris(resolution, CHAT_COMMON_CONFIGS_FILE_NAME));
  const configUri = existingConfigUri ?? getCommonConfigsFileUriForDirectory(resolution.preferredCreateBaseDirectory);

  if (!existingConfigUri) {
    await vscode.workspace.fs.createDirectory(getChatDataDirectoryUriForBaseDirectory(resolution.preferredCreateBaseDirectory));

    try {
      await vscode.workspace.fs.stat(configUri);
    } catch {
      await vscode.workspace.fs.writeFile(configUri, Buffer.from(createDefaultCommonConfigsFileContent(), 'utf8'));
    }
  }

  const configDocument = await vscode.workspace.openTextDocument(configUri);
  await vscode.window.showTextDocument(configDocument, { preview: false });
}

async function renameChatTitle(targetUri: vscode.Uri): Promise<void> {
  const document = await vscode.workspace.openTextDocument(targetUri);
  const fallbackTitle = trimChatFileSuffix(path.basename(targetUri.fsPath));
  const parsed = safeParseChatDocument(document.getText(), fallbackTitle);
  if (parsed.error) {
    throw new Error(t('host.cannotModifyCorruptChat', { error: parsed.error }));
  }

  const nextTitle = await vscode.window.showInputBox({
    prompt: t('host.renameChatPrompt'),
    value: parsed.chat.title,
    valueSelection: [0, parsed.chat.title.length],
    validateInput: (value) => value.trim() ? undefined : t('host.titleCannotBeEmpty')
  });

  if (nextTitle === undefined) {
    return;
  }

  const normalizedTitle = nextTitle.trim();
  if (!normalizedTitle || normalizedTitle === parsed.chat.title) {
    return;
  }

  parsed.chat.title = normalizedTitle;
  parsed.chat.updatedAt = new Date().toISOString();
  await replaceDocumentContent(document, serializeChatFile(parsed.chat));
}

async function regenerateChatTitle(targetUri: vscode.Uri): Promise<boolean> {
  const document = await vscode.workspace.openTextDocument(targetUri);
  const fallbackTitle = trimChatFileSuffix(path.basename(targetUri.fsPath));
  const parsed = safeParseChatDocument(document.getText(), fallbackTitle);
  if (parsed.error) {
    throw new Error(t('host.cannotModifyCorruptChat', { error: parsed.error }));
  }

  const keyConfig = await loadKeyConfig(document);
  const nextTitle = await generateChatTitleWithAI(parsed.chat, keyConfig);
  if (!nextTitle || nextTitle === parsed.chat.title) {
    return false;
  }

  parsed.chat.title = nextTitle;
  parsed.chat.updatedAt = new Date().toISOString();
  await replaceDocumentContent(document, serializeChatFile(parsed.chat));
  return true;
}

function getChatTitleSourceContent(chat: ChatFile): string | undefined {
  const activeMessages = getActiveConversationMessages(chat);
  const seenMessageIds = new Set<string>();

  for (const message of [...activeMessages, ...chat.messages]) {
    if (message.role !== 'user' || seenMessageIds.has(message.id)) {
      continue;
    }

    seenMessageIds.add(message.id);
    const content = getMessageCurrentContent(message);
    if (normalizeSessionPreviewText(content)) {
      return content;
    }
  }

  return undefined;
}

function resolveSingleSessionCommandTargetUri(
  item: ChatSessionSummary | undefined,
  selectedItems: readonly ChatSessionTreeNode[] | undefined,
  emptyMessage: string
): vscode.Uri | undefined {
  const selectedSessions = getCommandSelectedSessions(selectedItems);

  if (item) {
    if (selectedSessions.length > 1 && selectedSessions.some((session) => session.uri.toString() === item.uri.toString())) {
      void vscode.window.showInformationMessage(t('host.multiSelectActionInfoOneOnly'));
      return undefined;
    }

    return item.uri;
  }

  if (selectedSessions.length > 1) {
    void vscode.window.showInformationMessage(t('host.multiSelectActionInfoOneOnlyShort'));
    return undefined;
  }

  if (selectedSessions.length === 1) {
    return selectedSessions[0].uri;
  }

  const activeUri = getActiveChatEditorDocumentUri();
  if (!activeUri) {
    void vscode.window.showInformationMessage(emptyMessage);
    return undefined;
  }

  return activeUri;
}

async function resolveDeleteChatSessionTargets(
  item: ChatSessionSummary | undefined,
  selectedItems: readonly ChatSessionTreeNode[] | undefined,
  currentSelection: readonly ChatSessionTreeNode[],
  sessionsProvider: ChatSessionsProvider
): Promise<ChatSessionSummary[]> {
  const currentSelectedSessions = getCommandSelectedSessions(currentSelection);
  if (currentSelectedSessions.length > 1) {
    return currentSelectedSessions;
  }

  const selectedSessions = getCommandSelectedSessions(selectedItems);

  if (selectedSessions.length > 1) {
    return selectedSessions;
  }

  if (item) {
    if (selectedSessions.length === 1 && selectedSessions.some((session) => session.uri.toString() === item.uri.toString())) {
      return selectedSessions;
    }

    return [item];
  }

  if (selectedSessions.length > 0) {
    return selectedSessions;
  }

  const activeUri = getActiveChatEditorDocumentUri();
  if (!activeUri) {
    return [];
  }

  const activeSession = sessionsProvider.getSessionByUri(activeUri) ?? await createChatSessionSummary(activeUri);
  return [activeSession];
}

function getCommandSelectedSessions(selectedItems?: readonly ChatSessionTreeNode[]): ChatSessionSummary[] {
  return (selectedItems ?? []).filter((item): item is ChatSessionSummary => item.kind === 'session');
}

async function confirmDeleteChatSessions(targets: readonly ChatSessionSummary[]): Promise<boolean> {
  const firstStepLabel = targets.length === 1 ? t('host.confirmDeleteFirstStepSingle') : t('host.confirmDeleteFirstStepMulti', { count: targets.length });
  const secondStepLabel = targets.length === 1 ? t('host.confirmDeleteSecondStepSingle') : t('host.confirmDeleteSecondStepMulti', { count: targets.length });
  const detailLines = [
    targets.length === 1
      ? t('host.confirmDeleteTitleLine', { title: targets[0]?.title ?? trimChatFileSuffix(path.basename(targets[0]?.uri.fsPath ?? '')) })
      : t('host.confirmDeleteCountLine', { count: targets.length }),
    ...targets.slice(0, 5).map((target) => `- ${target.title}`),
    targets.length > 5 ? t('host.confirmDeleteOverflowLine', { count: targets.length - 5 }) : undefined,
    targets.length === 1 && targets[0]?.preview ? t('host.confirmDeletePreviewLine', { preview: getDeletionPreview(targets[0].preview) }) : undefined,
    t('host.confirmDeleteCannotRecoverLine')
  ].filter((line): line is string => Boolean(line));

  const firstConfirmation = await vscode.window.showWarningMessage(
    targets.length === 1 ? t('host.confirmDeleteFirstPromptSingle') : t('host.confirmDeleteFirstPromptMulti', { count: targets.length }),
    {
      modal: true,
      detail: detailLines.join('\n')
    },
    firstStepLabel
  );

  if (firstConfirmation !== firstStepLabel) {
    return false;
  }

  const secondConfirmation = await vscode.window.showWarningMessage(
    targets.length === 1 ? t('host.confirmDeleteSecondPromptSingle', { title: targets[0]?.title ?? t('host.confirmDeleteFallbackSessionName') }) : t('host.confirmDeleteSecondPromptMulti', { count: targets.length }),
    {
      modal: true,
      detail: t('host.confirmDeleteDetailWillDelete')
    },
    secondStepLabel
  );

  return secondConfirmation === secondStepLabel;
}

async function closeChatEditors(targetUris: readonly vscode.Uri[]): Promise<void> {
  if (targetUris.length === 0) {
    return;
  }

  const targetSet = new Set(targetUris.map((uri) => uri.toString()));
  const tabsToClose = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => {
      const tabUri = getTabInputUri(tab.input);
      return tabUri ? targetSet.has(tabUri.toString()) : false;
    });

  if (tabsToClose.length === 0) {
    return;
  }

  const didClose = await vscode.window.tabGroups.close(tabsToClose, true);
  if (!didClose) {
    throw new Error(t('host.cannotCloseOpenChat'));
  }
}

function getTabInputUri(input: unknown): vscode.Uri | undefined {
  if (
    input instanceof vscode.TabInputText
    || input instanceof vscode.TabInputCustom
    || input instanceof vscode.TabInputNotebook
  ) {
    return input.uri;
  }

  if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
    return input.modified;
  }

  return undefined;
}

async function loadChatSessionSummaries(): Promise<ChatSessionSummary[]> {
  const files = await vscode.workspace.findFiles(CHAT_FILE_GLOB);
  const summaries = await Promise.all(files.map((uri) => createChatSessionSummary(uri)));

  return summaries.sort((left, right) => compareIsoDesc(left.updatedAt, right.updatedAt) || compareSessionLabels(left.title, right.title));
}

async function setSessionsViewVisibilityContext(isVisible: boolean): Promise<void> {
  await vscode.commands.executeCommand('setContext', SESSIONS_VIEW_VISIBILITY_CONTEXT, isVisible);
}

async function hasAnyChatDataDirectoryInWorkspace(): Promise<boolean> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  for (const workspaceFolder of workspaceFolders) {
    if (await workspaceContainsChatDataDirectory(workspaceFolder.uri)) {
      return true;
    }
  }

  return false;
}

async function workspaceContainsChatDataDirectory(baseUri: vscode.Uri): Promise<boolean> {
  const queue: vscode.Uri[] = [baseUri];

  while (queue.length > 0) {
    const currentUri = queue.shift();
    if (!currentUri) {
      continue;
    }

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(currentUri);
    } catch {
      continue;
    }

    for (const [name, fileType] of entries) {
      if ((fileType & vscode.FileType.Directory) === 0) {
        continue;
      }

      if (name === CHAT_DIRECTORY_NAME) {
        return true;
      }

      if (shouldSkipChatDirectoryScan(name)) {
        continue;
      }

      queue.push(vscode.Uri.joinPath(currentUri, name));
    }
  }

  return false;
}

function shouldSkipChatDirectoryScan(name: string): boolean {
  return [
    '.git',
    '.hg',
    '.next',
    '.svn',
    '.yarn',
    'bin',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'obj',
    'out',
    'target'
  ].includes(name);
}

async function createChatSessionSummary(uri: vscode.Uri): Promise<ChatSessionSummary> {
  const fallbackTitle = trimChatFileSuffix(path.basename(uri.fsPath));
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  const relativePath = getSessionRelativePath(uri);
  const directoryPath = getSessionDirectoryPath(relativePath);
  const directorySegments = directoryPath ? directoryPath.split('/') : [];

  try {
    const stat = await vscode.workspace.fs.stat(uri);
    const raw = await vscode.workspace.fs.readFile(uri);
    const parsed = safeParseChatDocument(Buffer.from(raw).toString('utf8'), fallbackTitle);
    const createdAtFallback = fileStatTimeToIso(stat.ctime) ?? new Date(0).toISOString();
    const updatedAtFallback = fileStatTimeToIso(stat.mtime) ?? createdAtFallback;
    const assistantName = await resolveSessionAssistantName(uri, parsed.chat);

    return {
      kind: 'session',
      uri,
      title: parsed.chat.title,
      createdAt: parsed.error ? createdAtFallback : parsed.chat.createdAt,
      updatedAt: parsed.error ? updatedAtFallback : parsed.chat.updatedAt,
      assistantName,
      messageCount: parsed.chat.messages.length,
      preview: buildSessionPreview(parsed.chat),
      relativePath,
      directoryPath,
      directorySegments,
      workspaceFolderKey: workspaceFolder?.uri.toString() ?? '',
      workspaceFolderName: workspaceFolder?.name,
      hasError: Boolean(parsed.error),
      error: parsed.error
    };
  } catch (error) {
    return {
      kind: 'session',
      uri,
      title: fallbackTitle,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      messageCount: 0,
      preview: '',
      relativePath,
      directoryPath,
      directorySegments,
      workspaceFolderKey: workspaceFolder?.uri.toString() ?? '',
      workspaceFolderName: workspaceFolder?.name,
      hasError: true,
      error: toErrorMessage(error)
    };
  }
}

function buildChatSessionTree(summaries: ChatSessionSummary[]): ChatSessionTreeNode[] {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (workspaceFolders.length > 1) {
    const rootNodes: ChatSessionTreeNode[] = [];
    const summariesByWorkspaceKey = new Map<string, ChatSessionSummary[]>();

    for (const summary of summaries) {
      const existing = summariesByWorkspaceKey.get(summary.workspaceFolderKey);
      if (existing) {
        existing.push(summary);
      } else {
        summariesByWorkspaceKey.set(summary.workspaceFolderKey, [summary]);
      }
    }

    for (const workspaceFolder of workspaceFolders) {
      const workspaceKey = workspaceFolder.uri.toString();
      const workspaceSummaries = summariesByWorkspaceKey.get(workspaceKey);
      if (!workspaceSummaries || workspaceSummaries.length === 0) {
        continue;
      }

      rootNodes.push({
        kind: 'folder',
        id: `workspace:${workspaceKey}`,
        label: workspaceFolder.name,
        relativePath: workspaceFolder.name,
        children: buildChatSessionFolderChildren(workspaceSummaries, [])
      });
    }

    return rootNodes;
  }

  return buildChatSessionFolderChildren(summaries, []);
}

function buildChatSessionFolderChildren(
  summaries: ChatSessionSummary[],
  parentSegments: string[]
): ChatSessionTreeNode[] {
  const directSessions = summaries
    .filter((summary) => hasMatchingDirectorySegments(summary, parentSegments) && summary.directorySegments.length === parentSegments.length)
    .sort((left, right) => compareIsoDesc(left.updatedAt, right.updatedAt) || compareSessionLabels(left.title, right.title));

  const nestedSummaryGroups = new Map<string, ChatSessionSummary[]>();
  for (const summary of summaries) {
    if (!hasMatchingDirectorySegments(summary, parentSegments) || summary.directorySegments.length <= parentSegments.length) {
      continue;
    }

    const segment = summary.directorySegments[parentSegments.length];
    const existing = nestedSummaryGroups.get(segment);
    if (existing) {
      existing.push(summary);
    } else {
      nestedSummaryGroups.set(segment, [summary]);
    }
  }

  const folderNodes = [...nestedSummaryGroups.entries()]
    .sort(([left], [right]) => compareSessionLabels(left, right))
    .map(([segment, groupSummaries]) => {
      const nextSegments = [...parentSegments, segment];
      return {
        kind: 'folder' as const,
        id: `folder:${groupSummaries[0]?.workspaceFolderKey ?? ''}:${nextSegments.join('/')}`,
        label: segment,
        relativePath: nextSegments.join('/'),
        children: buildChatSessionFolderChildren(groupSummaries, nextSegments)
      };
    });

  return [...folderNodes, ...directSessions];
}

function hasMatchingDirectorySegments(summary: ChatSessionSummary, parentSegments: string[]): boolean {
  return parentSegments.every((segment, index) => summary.directorySegments[index] === segment);
}

function compareSessionLabels(left: string, right: string): number {
  return left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function getSessionDirectoryPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const directoryPath = path.posix.dirname(normalized);
  return directoryPath === '.' ? '' : directoryPath;
}

function fileStatTimeToIso(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

function buildSessionPreview(chat: ChatFile): string {
  const messages = getActiveConversationMessages(chat);
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = normalizeSessionPreviewText(getMessageCurrentContent(messages[i]));
    if (text) return truncateSessionPreviewText(text);
  }
  return t('host.emptyContentParenthesis');
}

function normalizeSessionPreviewText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateSessionPreviewText(value: string, maxLength: number = 92): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function getSessionRelativePath(uri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return path.basename(uri.fsPath);
  }

  return path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
}

function compareIsoDesc(left: string, right: string): number {
  return new Date(right).getTime() - new Date(left).getTime();
}

function formatSessionUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return t('host.timeUnknown');
  }

  return new Intl.DateTimeFormat(getLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function createSessionTooltip(session: ChatSessionSummary): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = false;
  markdown.appendMarkdown(`**${escapeMarkdown(session.title)}**\n\n`);
  markdown.appendMarkdown(t('host.sessionPathMd', { path: escapeMarkdown(session.relativePath) }));
  markdown.appendMarkdown(t('host.sessionStatsMd', { count: session.messageCount, time: escapeMarkdown(formatSessionUpdatedAt(session.updatedAt)) }));
  if (session.assistantName) {
    markdown.appendMarkdown(t('host.sessionAssistantMd', { name: escapeMarkdown(session.assistantName) }));
  }
  if (session.preview) {
    markdown.appendMarkdown(`${escapeMarkdown(session.preview)}\n\n`);
  }
  if (session.error) {
    markdown.appendMarkdown(t('host.sessionParseErrorMd', { detail: escapeMarkdown(session.error) }));
  }
  return markdown;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
}

function getActiveChatEditorDocumentUri(): vscode.Uri | undefined {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && activeEditor.document.uri.fsPath.endsWith(CHAT_FILE_EXTENSION)) {
    return activeEditor.document.uri;
  }

  return undefined;
}

async function reopenActiveChatTextEditorIfNeeded(): Promise<void> {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor || !activeEditor.document.uri.fsPath.endsWith(CHAT_FILE_EXTENSION)) {
    return;
  }

  const activeTabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (
    activeTabInput instanceof vscode.TabInputCustom
    && activeTabInput.viewType === VIEW_TYPE
    && activeTabInput.uri.toString() === activeEditor.document.uri.toString()
  ) {
    return;
  }

  try {
    await vscode.commands.executeCommand('vscode.openWith', activeEditor.document.uri, VIEW_TYPE);
  } catch (error) {
    console.error('Failed to reopen chat file with custom editor.', error);
  }
}

function resolveRawJsonTargetUri(input?: ChatSessionSummary | vscode.Uri): vscode.Uri | undefined {
  if (input instanceof vscode.Uri) {
    return input;
  }
  if (input && typeof input === 'object' && 'uri' in input && input.uri instanceof vscode.Uri) {
    return input.uri;
  }

  const active = getActiveChatEditorDocumentUri();
  if (active) {
    return active;
  }

  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.fsPath.endsWith(CHAT_FILE_EXTENSION)) {
      return document.uri;
    }
  }

  return undefined;
}

function getPreferredNewChatBaseDirectoryUri(resourceUri?: vscode.Uri): vscode.Uri {
  const effectiveResourceUri = resourceUri ?? getActiveChatEditorDocumentUri() ?? vscode.window.activeTextEditor?.document.uri;
  if (effectiveResourceUri && (effectiveResourceUri.scheme === 'file' || effectiveResourceUri.scheme === 'untitled')) {
    return vscode.Uri.file(path.dirname(effectiveResourceUri.fsPath));
  }

  const workspaceFolder = effectiveResourceUri
    ? getPreferredWorkspaceFolderUri(effectiveResourceUri)
    : getPreferredWorkspaceFolderUri();
  if (workspaceFolder) {
    return workspaceFolder;
  }

  return getHomeDirectoryUri();
}

async function createUniqueChatFileUri(baseDirectoryUri: vscode.Uri): Promise<vscode.Uri> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidateUri = vscode.Uri.joinPath(baseDirectoryUri, createGeneratedChatFileName());

    try {
      await vscode.workspace.fs.stat(candidateUri);
    } catch {
      return candidateUri;
    }
  }

  throw new Error(t('host.cannotGenerateUniqueFileName'));
}

function createUntitledChatFileUri(targetUri: vscode.Uri): vscode.Uri {
  return targetUri.with({ scheme: 'untitled' });
}

function createGeneratedChatFileName(now: Date = new Date()): string {
  const pad = (value: number, length: number = 2) => String(value).padStart(length, '0');
  const timestamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join('');
  const time = [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('');
  const milliseconds = pad(now.getMilliseconds(), 3);
  const suffix = crypto.randomBytes(3).toString('hex');

  return `chat-${timestamp}-${time}${milliseconds}-${suffix}${CHAT_FILE_EXTENSION}`;
}

async function resolveChatDataDirectoryResolution(resourceUri?: vscode.Uri): Promise<ChatDataDirectoryResolution> {
  const effectiveResourceUri = resourceUri ?? vscode.window.activeTextEditor?.document.uri;
  const resourceDirectoryUri = effectiveResourceUri
    ? await getDirectoryUriFromResource(effectiveResourceUri)
    : undefined;
  const workspaceFolder = effectiveResourceUri
    ? getPreferredWorkspaceFolderUri(effectiveResourceUri)
    : getPreferredWorkspaceFolderUri();
  const homeDirectory = getHomeDirectoryUri();

  const candidateBaseDirectories = dedupeUriList(
    [resourceDirectoryUri, workspaceFolder, homeDirectory].filter((value): value is vscode.Uri => value !== undefined)
  );

  return {
    candidateBaseDirectories,
    preferredCreateBaseDirectory: workspaceFolder ?? resourceDirectoryUri ?? homeDirectory
  };
}

async function getDirectoryUriFromResource(resourceUri: vscode.Uri): Promise<vscode.Uri> {
  let stat: vscode.FileStat | undefined;

  try {
    stat = await vscode.workspace.fs.stat(resourceUri);
  } catch {
    // Fall through and infer by file path.
  }

  const resourcePath = stat && (stat.type & vscode.FileType.Directory) !== 0
    ? resourceUri.fsPath
    : path.dirname(resourceUri.fsPath);
  const containingBasePath = findContainingChatDataBasePath(resourcePath);
  if (containingBasePath) {
    return vscode.Uri.file(containingBasePath);
  }

  if (stat && (stat.type & vscode.FileType.Directory) !== 0) {
    return resourceUri;
  }

  return vscode.Uri.file(path.dirname(resourceUri.fsPath));
}

function createDefaultKeyFileContent(): string {
  return `${JSON.stringify(
    {
      providers: {
        'example-provider': {
          label: 'Example Provider',
          transport: 'openai-compatible',
          api_key: '<your-api-key>',
          api_base: 'https://your-host/v1',
          models: [
            {
              id: 'your-model-id',
              label: 'Your Model',
              options: [
                {
                  id: 'default',
                  label: 'Default',
                  config: {}
                }
              ]
            }
          ]
        }
      },
      titleGeneration: {
        selection: {
          providerId: 'example-provider',
          modelId: 'your-model-id',
          optionId: 'default'
        }
      }
    },
    null,
    2
  )}\n`;
}

function createDefaultCommonConfigsFileContent(): string {
  return `${JSON.stringify(
    {
      default: {
        name: t('host.generalAssistantName'),
        system_prompt: t('host.generalAssistantSystemPrompt'),
        message_template: '{{ message }}'
      }
    },
    null,
    2
  )}\n`;
}

function assertNoUnsupportedKeyFileFields(raw: Record<string, unknown>): void {
  const unsupportedFields = Object.keys(raw).filter((key) => UNSUPPORTED_KEY_FILE_FIELDS.has(key));
  if (unsupportedFields.length > 0) {
    throw new Error(t('host.keyJsonRemovedFields', { fields: unsupportedFields.join(', ') }));
  }

  const legacyTopLevelFields = [
    'transport',
    'providerId',
    'model',
    'assistantName',
    'api_key',
    'api_base',
    'temperature'
  ].filter((key) => key in raw);

  if (legacyTopLevelFields.length > 0) {
    throw new Error(t('host.keyJsonLegacyFlat', { fields: legacyTopLevelFields.join(', ') }));
  }
}

class OneFileChatEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly busyDocuments = new Set<string>();
  private readonly requestMutexByDocument = new Map<string, AsyncMutex>();
  private readonly activeAbortControllers = new Map<string, AbortController>();
  private readonly closingAbortControllers = new WeakSet<AbortController>();
  private readonly modelSelectionByDocument = new Map<string, ChatModelSelection>();
  private readonly streamDataByDocument = new Map<string, EditorStreamData>();
  private readonly pendingInitialPromptsByDocument = new Map<
    string,
    { prompt: string; attachments: WebviewIncomingAttachment[] }
  >();

  constructor(private readonly context: vscode.ExtensionContext) {}

  private getDocumentRequestMutex(document: vscode.TextDocument): AsyncMutex {
    const documentKey = document.uri.toString();
    let mutex = this.requestMutexByDocument.get(documentKey);

    if (!mutex) {
      mutex = new AsyncMutex();
      this.requestMutexByDocument.set(documentKey, mutex);
    }

    return mutex;
  }

  private async handoffPendingInitialPrompt(
    document: vscode.TextDocument,
    prompt: string,
    attachments: WebviewIncomingAttachment[]
  ): Promise<void> {
    const targetUri = document.uri.with({ scheme: 'file' });
    const targetKey = targetUri.toString();

    this.pendingInitialPromptsByDocument.set(targetKey, {
      prompt,
      attachments: attachments.map((attachment) => ({ ...attachment }))
    });

    try {
      const saved = await document.save();
      if (!saved) {
        throw new Error(t('host.firstSendCreateChatFailed'));
      }

      await vscode.commands.executeCommand('vscode.openWith', targetUri, VIEW_TYPE);
    } catch (error) {
      this.pendingInitialPromptsByDocument.delete(targetKey);
      throw error;
    }
  }

  private takePendingInitialPrompt(
    document: vscode.TextDocument
  ): { prompt: string; attachments: WebviewIncomingAttachment[] } | undefined {
    const documentKey = document.uri.toString();
    const pending = this.pendingInitialPromptsByDocument.get(documentKey);
    if (!pending) {
      return undefined;
    }

    this.pendingInitialPromptsByDocument.delete(documentKey);
    return pending;
  }

  private async persistLatestStreamSnapshotOnDispose(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme !== 'file') {
      return;
    }

    const documentKey = document.uri.toString();
    const latestSnapshot = this.streamDataByDocument.get(documentKey)?.latestSnapshot;
    if (!latestSnapshot) {
      return;
    }

    const partialContent = latestSnapshot.content;
    const partialReasoning = latestSnapshot.reasoningContent;
    const hasVisibleOutput = partialContent.trim().length > 0 || partialReasoning.trim().length > 0;
    if (!hasVisibleOutput) {
      return;
    }

    let sourceText: string;
    try {
      sourceText = document.isClosed ? decodeUtf8(await vscode.workspace.fs.readFile(document.uri)) : document.getText();
    } catch (error) {
      console.error(`[onefilechat] Failed to read chat document while persisting streamed snapshot for ${documentKey}:`, error);
      return;
    }

    let nextContent: string;
    try {
      const chat = parseChatDocument(sourceText, trimChatFileSuffix(path.basename(document.uri.fsPath)));
      if (!chat.messages.some((message) => message.id === latestSnapshot.messageId)) {
        return;
      }

      const nextReasoningContent = partialReasoning || undefined;
      const nextChat = updateMessageById(chat, latestSnapshot.messageId, (message) => {
        const updatedMessage = setMessageCurrentContent(message, partialContent, undefined, {
          ...(nextReasoningContent !== undefined ? { reasoningContent: nextReasoningContent } : {})
        });

        return {
          ...updatedMessage,
          reasoningContent: nextReasoningContent,
          status: 'completed'
        };
      });

      nextContent = serializeChatFile(nextChat);
    } catch (error) {
      console.error(`[onefilechat] Failed to persist streamed snapshot for message ${latestSnapshot.messageId} in ${documentKey}:`, error);
      return;
    }

    try {
      await vscode.workspace.fs.writeFile(document.uri, Buffer.from(nextContent, 'utf8'));
    } catch (error) {
      console.error(`[onefilechat] Failed to write streamed snapshot for ${documentKey}:`, error);
    }
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const documentWorkspaceFolder = getWorkspaceFolderUriForDocument(document);
    let webviewReloadTimer: ReturnType<typeof setTimeout> | undefined;

    const reloadWebview = (): void => {
      if (webviewReloadTimer !== undefined) {
        clearTimeout(webviewReloadTimer);
      }

      webviewReloadTimer = setTimeout(() => {
        webviewReloadTimer = undefined;
        webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
      }, 40);
    };

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'out'),
        getChatDirectoryUri(document),
        ...(documentWorkspaceFolder ? [documentWorkspaceFolder] : [])
      ]
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    const mediaWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.join(this.context.extensionUri.fsPath, 'media'), '{dist/webview.js,chat.css}')
    );
    mediaWatcher.onDidChange(() => reloadWebview());
    mediaWatcher.onDidCreate(() => reloadWebview());
    mediaWatcher.onDidDelete(() => reloadWebview());

    let currentError: string | undefined;
    let postChunkQueue = Promise.resolve();

    const postState = async (): Promise<void> => {
      const fallbackTitle = trimChatFileSuffix(path.basename(document.uri.fsPath));
      const parsed = safeParseChatDocument(document.getText(), fallbackTitle);
      webviewPanel.title = parsed.chat.title || fallbackTitle;
      let configError: string | undefined;
      let commonConfigError: string | undefined;
      let availableProviders: WebviewProviderItem[] = [];
      let currentSelection: ChatModelSelection | undefined;
      let keyConfig: KeyFileConfig | undefined;
      let commonConfigs: CommonConfigsFile = {};

      const [keyConfigResult, commonConfigsResult] = await Promise.allSettled([
        loadKeyConfig(document),
        loadCommonConfigs(document)
      ]);

      try {
        if (keyConfigResult.status === 'rejected') {
          throw keyConfigResult.reason;
        }

        keyConfig = keyConfigResult.value;
        availableProviders = createWebviewProviderItems(keyConfig);
        currentSelection = this.resolveDocumentSelection(document, parsed.chat, keyConfig);
      } catch (error) {
        configError = toErrorMessage(error);
        this.clearDocumentSelection(document);
      }

      try {
        if (commonConfigsResult.status === 'rejected') {
          throw commonConfigsResult.reason;
        }

        commonConfigs = commonConfigsResult.value;
      } catch (error) {
        commonConfigError = toErrorMessage(error);
      }

      const isBusy = this.busyDocuments.has(document.uri.toString());

      const payload: HostToWebviewMessage = {
        type: 'document',
        value: await createWebviewChatFile(webviewPanel.webview, document, parsed.chat, keyConfig),
        state: {
          error: currentError ?? parsed.error ?? configError ?? commonConfigError,
          fileName: fallbackTitle,
          isBusy,
          availableProviders,
          currentSelection,
          canSend: currentSelection !== undefined && !isBusy,
          commonConfig: createWebviewCommonConfigState(parsed.chat, commonConfigs),
          systemPrompt: createWebviewConfigFieldState(parsed.chat, commonConfigs, 'system_prompt'),
          messageTemplate: createWebviewConfigFieldState(parsed.chat, commonConfigs, 'message_template')
        }
      };

      await webviewPanel.webview.postMessage(payload);
    };

    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingChunk: StreamSnapshot | undefined;
    let latestSnapshot: StreamSnapshot | undefined;
    let streamAccumulationWarned = false;
    const STREAM_ACCUMULATION_SOFT_LIMIT_CHARS = 200 * 1024 * 1024;

    const flushChunkToWebview = (): void => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }

      if (!pendingChunk) {
        return;
      }

      const snapshot = pendingChunk;
      pendingChunk = undefined;

      postChunkQueue = postChunkQueue
        .then(async () => {
          const [contentHtml, reasoningContentHtml] = await Promise.all([
            renderMarkdownToHtml(snapshot.content),
            renderMarkdownToHtml(snapshot.reasoningContent)
          ]);

          const chunkPayload: HostToWebviewMessage = {
            type: 'streamChunk',
            messageId: snapshot.messageId,
            contentDelta: '',
            reasoningDelta: '',
            content: snapshot.content,
            reasoningContent: snapshot.reasoningContent,
            contentHtml,
            reasoningContentHtml
          };

          await webviewPanel.webview.postMessage(chunkPayload);
        })
        .catch((error) => {
          currentError = toErrorMessage(error);
        });
    };

    const postChunk = (
      messageId: string,
      _contentDelta: string,
      _reasoningDelta: string,
      content: string,
      reasoningContent: string
    ): void => {
      const snapshot = { messageId, content, reasoningContent };
      latestSnapshot = snapshot;
      pendingChunk = snapshot;

      if (!streamAccumulationWarned && content.length + reasoningContent.length >= STREAM_ACCUMULATION_SOFT_LIMIT_CHARS) {
        streamAccumulationWarned = true;
        console.warn(`[onefilechat] Streaming response for message ${messageId} exceeded the soft size limit (${STREAM_ACCUMULATION_SOFT_LIMIT_CHARS} chars); memory usage may be high.`);
        void vscode.window.showWarningMessage(t('host.streamResponseTooLarge'));
      }

      if (flushTimer === undefined) {
        flushTimer = setTimeout(flushChunkToWebview, 80);
      }
    };

    const streamData: EditorStreamData = {
      flush: () => {
        flushChunkToWebview();
      },
      get queue(): Promise<void> {
        return postChunkQueue.then(() => undefined);
      },
      get latestSnapshot(): StreamSnapshot | undefined {
        return latestSnapshot;
      }
    };
    this.streamDataByDocument.set(document.uri.toString(), streamData);

    const changeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() === document.uri.toString()) {
        // Drain any in-flight stream chunk renders first so the full-document
        // refresh can never race ahead of a pending streamChunk message and
        // momentarily render a stale view.
        void postChunkQueue.then(() => postState());
      }
    });

    const messageSubscription = webviewPanel.webview.onDidReceiveMessage(async (message: WebviewToHostMessage) => {
      if (message.type === 'ready') {
        await postState();

        const pendingInitialPrompt = this.takePendingInitialPrompt(document);
        if (pendingInitialPrompt) {
          currentError = undefined;

          try {
            await this.handlePrompt(document, pendingInitialPrompt.prompt, pendingInitialPrompt.attachments, postState, postChunk);
          } catch (error) {
            currentError = toErrorMessage(error);
            void vscode.window.showErrorMessage(currentError);
          } finally {
            await postState();
          }
        }

        return;
      }

      if (message.type === 'updateModelSelection') {
        currentError = undefined;

        try {
          this.assertDocumentNotBusy(document);

          const keyConfig = await loadKeyConfig(document);
          const nextSelection = normalizeChatModelSelection(
            {
              providerId: message.providerId,
              modelId: message.modelId,
              optionId: message.optionId
            },
            keyConfig
          );

          if (!nextSelection) {
            throw new Error(t('host.invalidModelSelection'));
          }

          this.setDocumentSelection(document, nextSelection);

          const currentChat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
          currentChat.modelSelection = nextSelection;
          await replaceDocumentContent(document, serializeChatFile(currentChat));
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'copyMessage') {
        const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
        const targetMessage = chat.messages.find((item) => item.id === message.messageId);
        if (!targetMessage) {
          return;
        }

        await vscode.env.clipboard.writeText(createClipboardMarkdownForMessage(targetMessage));
        return;
      }

      if (message.type === 'copyMessageVersion') {
        const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
        const targetMessage = chat.messages.find((item) => item.id === message.messageId);
        const version = targetMessage?.versions?.find((item) => item.id === message.versionId);
        if (!version) {
          return;
        }

        await vscode.env.clipboard.writeText(createClipboardMarkdownForVersion(version));
        return;
      }

      if (message.type === 'copyCodeBlock') {
        await vscode.env.clipboard.writeText(message.content);
        return;
      }

      if (message.type === 'importClipboardMarkdownAttachments') {
        const requestId = typeof message.requestId === 'string' ? message.requestId : '';
        const text = typeof message.text === 'string' ? message.text : '';

        try {
          const result = await createClipboardMarkdownAttachmentImport(document, text);
          await webviewPanel.webview.postMessage({
            type: 'clipboardMarkdownAttachments',
            requestId,
            ok: true,
            text: result.text,
            attachments: result.attachments
          });
        } catch (error) {
          await webviewPanel.webview.postMessage({
            type: 'clipboardMarkdownAttachments',
            requestId,
            ok: false,
            text,
            attachments: [],
            error: toErrorMessage(error)
          });
        }

        return;
      }

      if (message.type === 'persistEditorAttachments') {
        const requestId = typeof message.requestId === 'string' ? message.requestId : '';
        const incoming = Array.isArray(message.attachments) ? message.attachments : [];
        try {
          const persisted = await persistWebviewAttachments(document, incoming);
          await webviewPanel.webview.postMessage({
            type: 'editorAttachmentsPersisted',
            requestId,
            ok: true,
            attachments: persisted
          });
        } catch (error) {
          await webviewPanel.webview.postMessage({
            type: 'editorAttachmentsPersisted',
            requestId,
            ok: false,
            attachments: [],
            error: toErrorMessage(error)
          });
        }
        return;
      }

      if (message.type === 'stopGeneration') {
        this.stopGeneration(document);
        await postState();
        return;
      }

      if (message.type === 'editMessage') {
        currentError = undefined;

        try {
          await this.editMessage(document, message.messageId, message.content);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'restoreMessageVersion') {
        currentError = undefined;

        try {
          await this.restoreMessageVersion(document, message.messageId, message.versionId);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'deleteMessageVersion') {
        currentError = undefined;

        try {
          await this.deleteMessageVersion(document, message.messageId, message.versionId);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'deleteMessageBranch') {
        currentError = undefined;

        try {
          await this.deleteMessageBranch(document, message.messageId);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'rewriteMessageBranch') {
        currentError = undefined;

        try {
          await this.rewriteMessageBranch(
            document,
            message.messageId,
            message.content,
            message.continueGeneration === true,
            postState,
            postChunk
          );
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'createNewChat') {
        currentError = undefined;

        try {
          await createNewChatFile(document.uri);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'viewRawChatJson') {
        try {
          await vscode.commands.executeCommand('onefilechat.viewRawChatJson', document.uri);
        } catch (error) {
          void vscode.window.showErrorMessage(toErrorMessage(error));
        }
        return;
      }

      if (message.type === 'updateCommonConfigId') {
        currentError = undefined;

        try {
          this.assertDocumentNotBusy(document);

          const currentChat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
          const nextCommonConfigId = normalizeOptionalStringOrNull(message.commonConfigId) ?? null;
          if ((currentChat.commonConfigId ?? null) !== nextCommonConfigId) {
            currentChat.commonConfigId = nextCommonConfigId;
            currentChat.updatedAt = new Date().toISOString();
            await replaceDocumentContent(document, serializeChatFile(currentChat));
          }
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'saveConfigField') {
        currentError = undefined;

        try {
          this.assertDocumentNotBusy(document);

          const currentChat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
          const nextField = createInheritableTextFieldForSave(message.inherit, message.content);
          const currentField = message.field === 'systemPrompt' ? currentChat.systemPrompt : currentChat.messageTemplate;
          const currentContent = currentField?.content ?? null;

          if (currentField?.inherit !== nextField.inherit || currentContent !== nextField.content) {
            currentChat[message.field] = nextField;
            currentChat.updatedAt = new Date().toISOString();
            await replaceDocumentContent(document, serializeChatFile(currentChat));
          }
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'manageProviderConfig') {
        currentError = undefined;

        try {
          await manageProviderConfigCommand(document.uri);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'manageCommonConfig') {
        currentError = undefined;

        try {
          await manageCommonConfigCommand(document.uri);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'openExternalLink') {
        await openExternalMarkdownLink(message.href);
        return;
      }

      if (message.type === 'resendMessage') {
        currentError = undefined;

        try {
          await this.resendMessage(document, message.messageId, postState, postChunk);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'selectSibling') {
        currentError = undefined;

        try {
          await this.selectSibling(document, message.messageId, message.direction);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'branchMessage') {
        currentError = undefined;

        try {
          await this.branchMessage(document, message.messageId);
        } catch (error) {
          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          await postState();
        }

        return;
      }

      if (message.type === 'sendPrompt') {
        const requestId = typeof message.requestId === 'string' ? message.requestId.trim() : '';
        const prompt = typeof message.prompt === 'string' ? message.prompt.trim() : '';
        const attachments = Array.isArray(message.attachments) ? message.attachments : [];
        if (!prompt && attachments.length === 0) {
          return;
        }

        currentError = undefined;
        let accepted = false;
        let handedOff = false;

        try {
          if (document.isUntitled) {
            await this.handoffPendingInitialPrompt(document, prompt, attachments);
            handedOff = true;
            accepted = true;

            if (requestId) {
              try {
                await webviewPanel.webview.postMessage({
                  type: 'sendPromptResult',
                  requestId,
                  ok: true
                } satisfies HostToWebviewMessage);
              } catch {
                // The old untitled editor may already be disposed while the saved editor takes over.
              }
            }

            return;
          }

          await this.handlePrompt(document, prompt, attachments, postState, postChunk, async () => {
            accepted = true;

            if (!requestId) {
              return;
            }

            await webviewPanel.webview.postMessage({
              type: 'sendPromptResult',
              requestId,
              ok: true
            } satisfies HostToWebviewMessage);
          });
        } catch (error) {
          if (!accepted && requestId) {
            await webviewPanel.webview.postMessage({
              type: 'sendPromptResult',
              requestId,
              ok: false
            } satisfies HostToWebviewMessage);
          }

          currentError = toErrorMessage(error);
          void vscode.window.showErrorMessage(currentError);
        } finally {
          if (!handedOff) {
            await postState();
          }
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      const documentKey = document.uri.toString();
      const activeAbortController = this.activeAbortControllers.get(documentKey);
      if (activeAbortController) {
        this.closingAbortControllers.add(activeAbortController);
      }

      if (webviewReloadTimer !== undefined) {
        clearTimeout(webviewReloadTimer);
      }

      changeSubscription.dispose();
      messageSubscription.dispose();
      mediaWatcher.dispose();

      void (async () => {
        try {
          this.stopGeneration(document);
          await this.persistLatestStreamSnapshotOnDispose(document);
        } finally {
          this.clearDocumentSelection(document);
          this.requestMutexByDocument.delete(documentKey);
          this.streamDataByDocument.delete(documentKey);
        }
      })();
    });
  }

  private stopGeneration(document: vscode.TextDocument): void {
    const documentKey = document.uri.toString();
    const controller = this.activeAbortControllers.get(documentKey);
    if (!controller) {
      return;
    }

    controller.abort();
    this.activeAbortControllers.delete(documentKey);
  }

  private assertDocumentNotBusy(document: vscode.TextDocument): void {
    if (this.busyDocuments.has(document.uri.toString())) {
      throw new Error(t('host.pendingReplyInProgress'));
    }
  }

  private setDocumentSelection(document: vscode.TextDocument, selection: ChatModelSelection): void {
    this.modelSelectionByDocument.set(document.uri.toString(), selection);
  }

  private clearDocumentSelection(document: vscode.TextDocument): void {
    this.modelSelectionByDocument.delete(document.uri.toString());
  }

  private resolveDocumentSelection(
    document: vscode.TextDocument,
    chat: ChatFile,
    keyConfig: KeyFileConfig
  ): ChatModelSelection | undefined {
    const documentKey = document.uri.toString();
    const sessionSelection = normalizeChatModelSelection(this.modelSelectionByDocument.get(documentKey), keyConfig);
    if (sessionSelection) {
      this.modelSelectionByDocument.set(documentKey, sessionSelection);
      return sessionSelection;
    }

    const fileSelection = normalizeChatModelSelection(chat.modelSelection, keyConfig);
    if (fileSelection) {
      this.modelSelectionByDocument.set(documentKey, fileSelection);
      return fileSelection;
    }

    const restoredSelection = normalizeChatModelSelection(findLastAssistantSelection(chat), keyConfig);
    if (restoredSelection) {
      this.modelSelectionByDocument.set(documentKey, restoredSelection);
      return restoredSelection;
    }

    this.modelSelectionByDocument.delete(documentKey);
    return undefined;
  }

  private resolveRequestConfig(
    document: vscode.TextDocument,
    chat: ChatFile,
    keyConfig: KeyFileConfig
  ): ResolvedModelConfig {
    const selection = this.resolveDocumentSelection(document, chat, keyConfig);
    if (!selection) {
      throw new Error(t('host.selectModelFirst'));
    }

    return resolveModelConfig(keyConfig, selection);
  }

  private async handlePrompt(
    document: vscode.TextDocument,
    prompt: string,
    attachments: WebviewIncomingAttachment[],
    postState: () => Promise<void>,
    postChunk: (
      messageId: string,
      contentDelta: string,
      reasoningDelta: string,
      content: string,
      reasoningContent: string
    ) => void,
    onAccepted?: () => Promise<void>
  ): Promise<void> {
    this.assertDocumentNotBusy(document);

    const documentKey = document.uri.toString();
    this.busyDocuments.add(documentKey);

    try {
      await postState();

      const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
      const keyConfig = await loadKeyConfig(document);
      const config = this.resolveRequestConfig(document, chat, keyConfig);
      const assistantLabel = resolveAssistantName(config);
      const assistantMetadata = resolveAssistantMessageMetadata(config);
      const activeMessages = getActiveConversationMessages(chat);
      const parentMessage = activeMessages[activeMessages.length - 1];

      await validateConversationAttachmentReferences(document, activeMessages);

      const storedAttachments = await persistWebviewAttachments(document, attachments);
      const userBody = await composeUserMessageBody(document, prompt, storedAttachments);
      const userMessage = createMessage('user', userBody.content, {
        body: userBody.body,
        attachments: userBody.attachments,
        status: 'completed'
      });

      await validateConversationAttachmentReferences(document, [...activeMessages, userMessage]);

      const assistantMessage = createMessage('assistant', '', {
        assistantLabel,
        model: assistantMetadata.model,
        providerId: assistantMetadata.providerId,
        optionId: assistantMetadata.optionId,
        status: 'pending'
      });

      let nextChat = appendMessageToChat(chat, parentMessage?.id, userMessage);
      nextChat = appendMessageToChat(nextChat, userMessage.id, assistantMessage);
      nextChat.modelSelection = {
        providerId: config.providerId,
        modelId: config.model,
        optionId: config.optionId
      };

      await replaceDocumentContent(document, serializeChatFile(nextChat));
      await postState();
      await onAccepted?.();
      await maybeAutoUpdateChatTitle(document, keyConfig, config, userBody.content, chat.messages.length === 0);

      const messagesForModel = getMessagesForModel(getActiveConversationMessages(nextChat));
      const boundPostChunk = (c: string, r: string, content: string, reasoningContent: string) =>
        postChunk(assistantMessage.id, c, r, content, reasoningContent);

      await this.runAssistantRequest(document, assistantMessage.id, messagesForModel, config, boundPostChunk);
    } finally {
      this.busyDocuments.delete(documentKey);
    }
  }

  private async retryAssistantMessage(
    document: vscode.TextDocument,
    assistantMessageId: string,
    postState: () => Promise<void>,
    postChunk: (
      messageId: string,
      contentDelta: string,
      reasoningDelta: string,
      content: string,
      reasoningContent: string
    ) => void
  ): Promise<void> {
    this.assertDocumentNotBusy(document);

    const documentKey = document.uri.toString();
    this.busyDocuments.add(documentKey);

    try {
      await postState();

      const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
      const keyConfig = await loadKeyConfig(document);
      const config = this.resolveRequestConfig(document, chat, keyConfig);
      const assistantLabel = resolveAssistantName(config);
      const assistantMetadata = resolveAssistantMessageMetadata(config);
      const targetMessage = chat.messages.find((message) => message.id === assistantMessageId);

      if (!targetMessage || targetMessage.role !== 'assistant') {
        throw new Error(t('host.noRetryableAssistantMessage'));
      }

      if (!targetMessage.parentId) {
        throw new Error(t('host.noUserMessageForReply'));
      }

      const futureConversation = getConversationPathToMessage(chat, targetMessage.parentId);
      await validateConversationAttachmentReferences(document, futureConversation);

      const assistantMessage = createMessage('assistant', '', {
        assistantLabel,
        model: assistantMetadata.model,
        providerId: assistantMetadata.providerId,
        optionId: assistantMetadata.optionId,
        status: 'pending'
      });

      let nextChat = activateMessagePath(chat, targetMessage.parentId);
      nextChat = appendMessageToChat(nextChat, targetMessage.parentId, assistantMessage);
      nextChat.modelSelection = {
        providerId: config.providerId,
        modelId: config.model,
        optionId: config.optionId
      };

      await replaceDocumentContent(document, serializeChatFile(nextChat));
      await postState();

      const messagesForModel = getMessagesForModel(getActiveConversationMessages(nextChat));
      const boundPostChunk = (c: string, r: string, content: string, reasoningContent: string) =>
        postChunk(assistantMessage.id, c, r, content, reasoningContent);

      await this.runAssistantRequest(document, assistantMessage.id, messagesForModel, config, boundPostChunk);
    } finally {
      this.busyDocuments.delete(documentKey);
    }
  }

  private async resendMessage(
    document: vscode.TextDocument,
    messageId: string,
    postState: () => Promise<void>,
    postChunk: (
      messageId: string,
      contentDelta: string,
      reasoningDelta: string,
      content: string,
      reasoningContent: string
    ) => void
  ): Promise<void> {
    const currentChat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
    const currentMessage = currentChat.messages.find((message) => message.id === messageId);

    if (currentMessage?.role === 'assistant') {
      await this.retryAssistantMessage(document, messageId, postState, postChunk);
      return;
    }

    this.assertDocumentNotBusy(document);

    const documentKey = document.uri.toString();
    this.busyDocuments.add(documentKey);

    try {
      await postState();

      const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
      const keyConfig = await loadKeyConfig(document);
      const config = this.resolveRequestConfig(document, chat, keyConfig);
      const assistantLabel = resolveAssistantName(config);
      const assistantMetadata = resolveAssistantMessageMetadata(config);
      const targetMessage = chat.messages.find((message) => message.id === messageId);

      if (!targetMessage) {
        throw new Error(t('host.noResendableMessage'));
      }

      if (targetMessage.status === 'pending') {
        throw new Error(t('host.pendingCannotResend'));
      }

      if (targetMessage.role !== 'user') {
        throw new Error(t('host.resendUserOrAssistantOnly'));
      }

      if ((targetMessage.childIds?.length ?? 0) === 0) {
        await this.generateAssistantReplyForUserMessage(document, chat, targetMessage.id, postState, postChunk);
        return;
      }

      const targetBody = getMessageCurrentBody(targetMessage);
      const targetAttachments = getMessageCurrentAttachments(targetMessage);
      const userMessage = createMessage('user', getMessageCurrentContent(targetMessage), {
        body: targetBody,
        attachments: targetAttachments,
        status: 'completed'
      });

      const futureConversation = targetMessage.parentId
        ? [...getConversationPathToMessage(chat, targetMessage.parentId), userMessage]
        : [userMessage];

      await validateConversationAttachmentReferences(document, futureConversation);

      const assistantMessage = createMessage('assistant', '', {
        assistantLabel,
        model: assistantMetadata.model,
        providerId: assistantMetadata.providerId,
        optionId: assistantMetadata.optionId,
        status: 'pending'
      });

      let nextChat = targetMessage.parentId ? activateMessagePath(chat, targetMessage.parentId) : chat;
      nextChat = appendMessageToChat(nextChat, targetMessage.parentId, userMessage);
      nextChat = appendMessageToChat(nextChat, userMessage.id, assistantMessage);
      nextChat.modelSelection = {
        providerId: config.providerId,
        modelId: config.model,
        optionId: config.optionId
      };

      await replaceDocumentContent(document, serializeChatFile(nextChat));
      await postState();

      const messagesForModel = getMessagesForModel(getActiveConversationMessages(nextChat));
      const boundPostChunk = (c: string, r: string, content: string, reasoningContent: string) =>
        postChunk(assistantMessage.id, c, r, content, reasoningContent);

      await this.runAssistantRequest(document, assistantMessage.id, messagesForModel, config, boundPostChunk);
    } finally {
      this.busyDocuments.delete(documentKey);
    }
  }

  private async selectSibling(
    document: vscode.TextDocument,
    messageId: string,
    direction: 'previous' | 'next'
  ): Promise<void> {
    this.assertDocumentNotBusy(document);

    const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
    const targetMessage = chat.messages.find((message) => message.id === messageId);

    if (!targetMessage) {
      throw new Error(t('host.branchSwitchMessageMissing'));
    }

    const siblingIds = getSiblingIds(chat, targetMessage.parentId);
    if (siblingIds.length <= 1) {
      return;
    }

    const currentIndex = siblingIds.indexOf(targetMessage.id);
    if (currentIndex < 0) {
      throw new Error(t('host.branchStateInvalid'));
    }

    const nextIndex = direction === 'previous' ? currentIndex - 1 : currentIndex + 1;
    if (nextIndex < 0 || nextIndex >= siblingIds.length) {
      return;
    }

    const nextChat = setActiveSiblingSelection(chat, targetMessage.parentId, siblingIds[nextIndex]);
    await replaceDocumentContent(document, serializeChatFile(nextChat));
  }

  private async branchMessage(document: vscode.TextDocument, messageId: string): Promise<void> {
    const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
    const activeMessages = getActiveConversationMessages(chat);
    const messageIndex = activeMessages.findIndex((message) => message.id === messageId);

    if (messageIndex < 0) {
      throw new Error(t('host.branchExportMessageMissing'));
    }

    const targetMessage = activeMessages[messageIndex];
    if (targetMessage.status === 'pending') {
      throw new Error(t('host.pendingCannotExportBranch'));
    }

    const branchUri = await getNextBranchFileUri(document.uri);
    const branchChat = createTreeChatFromLinearMessages(
      trimChatFileSuffix(path.basename(branchUri.fsPath)),
      activeMessages.slice(0, messageIndex + 1)
    );
    branchChat.commonConfigId = chat.commonConfigId;
    branchChat.systemPrompt = chat.systemPrompt;
    branchChat.messageTemplate = chat.messageTemplate;
    branchChat.modelSelection = chat.modelSelection;

    await vscode.workspace.fs.writeFile(branchUri, Buffer.from(serializeChatFile(branchChat), 'utf8'));
    await vscode.commands.executeCommand('vscode.openWith', branchUri, VIEW_TYPE);
  }

  private async editMessage(document: vscode.TextDocument, messageId: string, content: string): Promise<void> {
    this.assertDocumentNotBusy(document);

    if (!hasMeaningfulMessageContent(content)) {
      throw new Error(t('host.messageContentRequired'));
    }

    const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));

    const targetMessage = chat.messages.find((message) => message.id === messageId);

    if (!targetMessage) {
      throw new Error(t('host.correctMessageMissing'));
    }

    if (targetMessage.status === 'pending') {
      throw new Error(t('host.pendingCannotCorrect'));
    }

    if (isCurrentMessageContent(targetMessage, content)) {
      return;
    }

    const { body, attachments, content: normalizedContent } = await composeUserMessageBody(
      document,
      content,
      []
    );

    if (
      normalizedContent !== content &&
      isCurrentMessageContent(targetMessage, normalizedContent)
    ) {
      return;
    }

    const nextChat = updateMessageById(chat, messageId, (message) => ({
      ...appendMessageVersion(message, normalizedContent, undefined, body, attachments),
      status: 'completed'
    }));
    await replaceDocumentContent(document, serializeChatFile(nextChat));
  }

  private async restoreMessageVersion(document: vscode.TextDocument, messageId: string, versionId: string): Promise<void> {
    this.assertDocumentNotBusy(document);
    const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
    const targetMessage = chat.messages.find((message) => message.id === messageId);

    if (!targetMessage) {
      throw new Error(t('host.restoreVersionMessageMissing'));
    }

    if (targetMessage.status === 'pending') {
      throw new Error(t('host.pendingCannotRestoreVersion'));
    }

    const version = findVersionById(targetMessage.versions, versionId);
    if (!version) {
      throw new Error(t('host.restoreVersionNotFound'));
    }

    if (isCurrentMessageVersion(targetMessage, version.id)) {
      return;
    }

    const nextChat = updateMessageById(chat, messageId, (message) => ({
      ...setMessageCurrentVersion(message, version.id),
      status: 'completed'
    }));
    await replaceDocumentContent(document, serializeChatFile(nextChat));
  }

  private async deleteMessageVersion(document: vscode.TextDocument, messageId: string, versionId: string): Promise<void> {
    this.assertDocumentNotBusy(document);
    const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
    const targetMessage = chat.messages.find((message) => message.id === messageId);

    if (!targetMessage) {
      throw new Error(t('host.deleteVersionMessageMissing'));
    }

    if (targetMessage.status === 'pending') {
      throw new Error(t('host.pendingCannotDeleteVersion'));
    }

    const versions = targetMessage.versions ?? [];
    if (versions.length <= 1) {
      throw new Error(t('host.deleteVersionKeepOne'));
    }

    if (isCurrentMessageVersion(targetMessage, versionId)) {
      throw new Error(t('host.deleteVersionCurrentBlocked'));
    }

    if (!findVersionById(versions, versionId)) {
      return;
    }

    const version = findVersionById(versions, versionId);
    if (!version) {
      return;
    }

    const versionPreview = getDeletionPreview(version.content);
    const confirmed = await vscode.window.showWarningMessage(
      t('host.deleteVersionPromptTitle'),
      {
        modal: true,
        detail: versionPreview
          ? t('host.deleteVersionDetailWithPreview', { preview: versionPreview })
          : t('host.deleteVersionDetail')
      },
      t('host.deleteVersionButton')
    );

    if (confirmed !== t('host.deleteVersionButton')) {
      return;
    }

    const nextChat = updateMessageById(chat, messageId, (message) => {
      const nextVersions = (message.versions ?? []).filter((version) => version.id !== versionId);
      const nextCurrentVersionId = normalizeCurrentVersionId(message.currentVersionId, nextVersions);
      const nextContent = getMessageCurrentContent({
        ...message,
        versions: nextVersions,
        currentVersionId: nextCurrentVersionId
      });

      return {
        ...message,
        content: nextContent,
        currentVersionId: nextCurrentVersionId,
        versions: nextVersions
      };
    });

    await replaceDocumentContent(document, serializeChatFile(nextChat));
  }

  private async deleteMessageBranch(document: vscode.TextDocument, messageId: string): Promise<void> {
    this.assertDocumentNotBusy(document);

    const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
    const targetMessage = chat.messages.find((message) => message.id === messageId);

    if (!targetMessage) {
      throw new Error(t('host.deleteBranchMessageMissing'));
    }

    if (targetMessage.status === 'pending') {
      throw new Error(t('host.pendingCannotDeleteBranch'));
    }

    const branchSize = collectDescendantMessageIds(chat, messageId).size;
    const preview = getDeletionPreview(getMessageCurrentContent(targetMessage));
    const targetLabel = targetMessage.role === 'assistant' ? t('host.deleteBranchTargetLabelAssistant') : t('host.deleteBranchTargetLabelUser');
    const confirmed = await vscode.window.showWarningMessage(
      t('host.deleteBranchPromptTitle'),
      {
        modal: true,
        detail: [
          t('host.deleteBranchDetailFollowups', { target: targetLabel, count: branchSize - 1 }),
          preview ? t('host.deleteBranchDetailPreview', { preview }) : undefined,
          t('host.deleteBranchDetailUndoHint')
        ]
          .filter(Boolean)
          .join('\n')
      },
      t('host.deleteBranchButton')
    );

    if (confirmed !== t('host.deleteBranchButton')) {
      return;
    }

    const nextChat = removeMessageById(chat, messageId);
    await replaceDocumentContent(document, serializeChatFile(nextChat));
  }

  private async rewriteMessageBranch(
    document: vscode.TextDocument,
    messageId: string,
    content: string,
    continueGeneration: boolean,
    postState: () => Promise<void>,
    postChunk: (
      messageId: string,
      contentDelta: string,
      reasoningDelta: string,
      content: string,
      reasoningContent: string
    ) => void
  ): Promise<void> {
    this.assertDocumentNotBusy(document);

    if (!hasMeaningfulMessageContent(content)) {
      throw new Error(t('host.messageContentRequired'));
    }

    const chat = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));

    const targetMessage = chat.messages.find((message) => message.id === messageId);

    if (!targetMessage) {
      throw new Error(t('host.rewriteBranchMessageMissing'));
    }

    if (targetMessage.role !== 'user') {
      throw new Error(t('host.rewriteBranchUserOnly'));
    }

    if (targetMessage.status === 'pending') {
      throw new Error(t('host.pendingCannotRewriteBranch'));
    }

    if (isCurrentMessageContent(targetMessage, content)) {
      throw new Error(t('host.rewriteBranchSameContent'));
    }

    const {
      body: rewrittenBody,
      attachments: rewrittenAttachments,
      content: rewrittenContent
    } = await composeUserMessageBody(document, content, []);

    if (
      rewrittenContent !== content &&
      isCurrentMessageContent(targetMessage, rewrittenContent)
    ) {
      throw new Error(t('host.rewriteBranchSameContent'));
    }

    const rewrittenMessage = createMessage('user', rewrittenContent, {
      status: 'completed',
      body: rewrittenBody,
      attachments: rewrittenAttachments
    });

    const futureConversation = targetMessage.parentId
      ? [...getConversationPathToMessage(chat, targetMessage.parentId), rewrittenMessage]
      : [rewrittenMessage];

    await validateConversationAttachmentReferences(document, futureConversation);

    const baseChat = targetMessage.parentId ? activateMessagePath(chat, targetMessage.parentId) : chat;
    const nextChat = appendMessageToChat(baseChat, targetMessage.parentId, rewrittenMessage);

    await replaceDocumentContent(document, serializeChatFile(nextChat));

    if (!continueGeneration) {
      return;
    }

    const documentKey = document.uri.toString();
    this.busyDocuments.add(documentKey);

    try {
      await postState();
      const latest = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
      await this.generateAssistantReplyForUserMessage(document, latest, rewrittenMessage.id, postState, postChunk);
    } finally {
      this.busyDocuments.delete(documentKey);
    }
  }

  private async generateAssistantReplyForUserMessage(
    document: vscode.TextDocument,
    chat: ChatFile,
    userMessageId: string,
    postState: () => Promise<void>,
    postChunk: (
      messageId: string,
      contentDelta: string,
      reasoningDelta: string,
      content: string,
      reasoningContent: string
    ) => void
  ): Promise<void> {
    const keyConfig = await loadKeyConfig(document);
    const config = this.resolveRequestConfig(document, chat, keyConfig);
    const assistantLabel = resolveAssistantName(config);
    const assistantMetadata = resolveAssistantMessageMetadata(config);

    const futureConversation = getConversationPathToMessage(chat, userMessageId);
    await validateConversationAttachmentReferences(document, futureConversation);

    const assistantMessage = createMessage('assistant', '', {
      assistantLabel,
      model: assistantMetadata.model,
      providerId: assistantMetadata.providerId,
      optionId: assistantMetadata.optionId,
      status: 'pending'
    });

    let nextChat = activateMessagePath(chat, userMessageId);
    nextChat = appendMessageToChat(nextChat, userMessageId, assistantMessage);
    nextChat.modelSelection = {
      providerId: config.providerId,
      modelId: config.model,
      optionId: config.optionId
    };

    await replaceDocumentContent(document, serializeChatFile(nextChat));
    await postState();

    const messagesForModel = getMessagesForModel(getActiveConversationMessages(nextChat));
    const boundPostChunk = (c: string, r: string, content: string, reasoningContent: string) =>
      postChunk(assistantMessage.id, c, r, content, reasoningContent);

    await this.runAssistantRequest(document, assistantMessage.id, messagesForModel, config, boundPostChunk);
  }

  private async runAssistantRequest(
    document: vscode.TextDocument,
    assistantMessageId: string,
    messagesForModel: ChatMessage[],
    config: ResolvedModelConfig,
    postChunk: (contentDelta: string, reasoningDelta: string, content: string, reasoningContent: string) => void
  ): Promise<void> {
    const documentKey = document.uri.toString();
    const abortController = new AbortController();
    const wasClosedDuringGeneration = (): boolean => this.closingAbortControllers.has(abortController);
    const requestMutex = this.getDocumentRequestMutex(document);
    this.activeAbortControllers.set(documentKey, abortController);
    const getLatestSnapshot = (): StreamSnapshot | undefined => {
      const latestSnapshot = this.streamDataByDocument.get(documentKey)?.latestSnapshot;
      if (!latestSnapshot || latestSnapshot.messageId !== assistantMessageId) {
        return undefined;
      }

      return latestSnapshot;
    };

    try {
      const latest = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
      const commonConfigs = await loadCommonConfigs(document);

      const assistantResponse = await requestMutex.runExclusive(async () =>
        requestCompletionStreaming(document, config, messagesForModel, postChunk, abortController.signal, latest, commonConfigs)
      );

      if (wasClosedDuringGeneration()) {
        return;
      }

      // Flush any pending throttled stream chunks and wait for the queue to drain
      const streamData = this.streamDataByDocument.get(documentKey);
      streamData?.flush();
      await streamData?.queue;

      const latestAfter = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
      const assistantMetadata = resolveAssistantMessageMetadata(config);
      const assistantBody = await createMessageBodyFromAssistantContent(document, assistantResponse.content);

      const nextChat = updateMessageById(latestAfter, assistantMessageId, (message) => ({
        ...setMessageCurrentStructuredContent(message, assistantBody.body, assistantBody.attachments, assistantBody.content, undefined, {
          reasoningContent: assistantResponse.reasoningContent,
          thinkingDurationMs: assistantResponse.thinkingDurationMs,
          totalDurationMs: assistantResponse.totalDurationMs,
          tokenStats: assistantResponse.tokenStats,
          model: assistantMetadata.model,
          providerId: assistantMetadata.providerId,
          optionId: assistantMetadata.optionId
        }),
        model: assistantMetadata.model,
        providerId: assistantMetadata.providerId,
        optionId: assistantMetadata.optionId,
        reasoningContent: assistantResponse.reasoningContent,
        thinkingDurationMs: assistantResponse.thinkingDurationMs,
        totalDurationMs: assistantResponse.totalDurationMs,
        tokenStats: assistantResponse.tokenStats,
        status: 'completed'
      }));
      await replaceDocumentContent(document, serializeChatFile(nextChat));
    } catch (error) {
      if (wasClosedDuringGeneration()) {
        return;
      }

      const streamData = this.streamDataByDocument.get(documentKey);
      streamData?.flush();
      await streamData?.queue;

      const latest = parseChatDocument(document.getText(), trimChatFileSuffix(path.basename(document.uri.fsPath)));
      const latestSnapshot = getLatestSnapshot();

      if (isRequestCanceledError(error)) {
        if (latest.messages.some((message) => message.id === assistantMessageId)) {
          const partialContent = error.partialContent || latestSnapshot?.content || '';
          const partialReasoning = error.partialReasoning || latestSnapshot?.reasoningContent || '';
          const hasVisibleOutput = partialContent.trim().length > 0 || partialReasoning.trim().length > 0;

          const nextChat = updateMessageById(latest, assistantMessageId, (message) => {
            if (!hasVisibleOutput) {
              return {
                ...message,
                reasoningContent: undefined,
                status: 'canceled'
              };
            }

            const nextReasoningContent = partialReasoning || undefined;
            const updatedMessage = setMessageCurrentContent(message, partialContent, undefined, {
              ...(nextReasoningContent !== undefined ? { reasoningContent: nextReasoningContent } : {})
            });

            return {
              ...updatedMessage,
              reasoningContent: nextReasoningContent,
              status: 'completed'
            };
          });
          await replaceDocumentContent(document, serializeChatFile(nextChat));
        }

        return;
      }

      if (latest.messages.some((message) => message.id === assistantMessageId)) {
        const nextChat = updateMessageById(latest, assistantMessageId, (message) => {
          const partialContent = latestSnapshot?.content || '';
          const partialReasoning = latestSnapshot?.reasoningContent || '';
          const hasVisibleOutput = partialContent.trim().length > 0 || partialReasoning.trim().length > 0;

          if (!hasVisibleOutput) {
            return {
              ...message,
              reasoningContent: undefined,
              status: 'error',
              errorDetail: toErrorMessage(error)
            };
          }

          const nextReasoningContent = partialReasoning || undefined;
          const updatedMessage = setMessageCurrentContent(message, partialContent, undefined, {
            ...(nextReasoningContent !== undefined ? { reasoningContent: nextReasoningContent } : {})
          });

          return {
            ...updatedMessage,
            reasoningContent: nextReasoningContent,
            status: 'completed'
          };
        });
        await replaceDocumentContent(document, serializeChatFile(nextChat));
        // The error is surfaced inside the assistant message bubble (and persisted to
        // the chat file), so we deliberately do not rethrow to avoid a duplicate popup.
        return;
      }

      throw error;
    } finally {
      this.closingAbortControllers.delete(abortController);
      const current = this.activeAbortControllers.get(documentKey);
      if (current === abortController) {
        this.activeAbortControllers.delete(documentKey);
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const assetVersion = encodeURIComponent(`${Date.now()}`);
    const codiconStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'vendor', 'codicons', 'codicon.css').with({
        query: `v=${assetVersion}`
      })
    );
    const katexStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'vendor', 'katex', 'katex.min.css').with({
        query: `v=${assetVersion}`
      })
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dist', 'webview.js').with({ query: `v=${assetVersion}` })
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css').with({ query: `v=${assetVersion}` })
    );

    return `<!DOCTYPE html>
<html lang="${getLocale()}">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: http: data:; style-src ${webview.cspSource}; style-src-elem ${webview.cspSource}; style-src-attr 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${codiconStyleUri}" />
    <link rel="stylesheet" href="${katexStyleUri}" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>One File Chat</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function createEmptyChatFile(title: string): ChatFile {
  const timestamp = new Date().toISOString();

  return {
    version: CHAT_FILE_VERSION,
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    rootMessageIds: [],
    activeChildByParentId: {},
    messages: []
  };
}

async function maybeAutoUpdateChatTitle(
  document: vscode.TextDocument,
  keyConfig: KeyFileConfig,
  fallbackConfig: ResolvedModelConfig,
  content: string,
  isFirstUserMessage: boolean
): Promise<void> {
  if (!isFirstUserMessage) {
    return;
  }

  try {
    const fallbackTitle = trimChatFileSuffix(path.basename(document.uri.fsPath));
    const latestChat = parseChatDocument(document.getText(), fallbackTitle);
    if (!shouldAutoGenerateChatTitle(latestChat.title, document.uri)) {
      return;
    }

    const nextTitle = await generateChatTitleBestEffort(latestChat, keyConfig, content, {
      fallbackConfig,
      allowInvalidCustomSelectionFallback: true
    });
    if (!nextTitle || nextTitle === latestChat.title) {
      return;
    }

    latestChat.title = nextTitle;
    latestChat.updatedAt = new Date().toISOString();
    await replaceDocumentContent(document, serializeChatFile(latestChat));
  } catch (error) {
    console.warn('One File Chat: auto title generation failed.', error);
  }
}

function shouldAutoGenerateChatTitle(currentTitle: string, documentUri: vscode.Uri): boolean {
  const fallbackTitle = trimChatFileSuffix(path.basename(documentUri.fsPath));
  return currentTitle.trim() === DEFAULT_CHAT_TITLE() || currentTitle.trim() === fallbackTitle;
}

function generateChatTitleFromContent(content: string): string {
  const normalized = normalizeSessionPreviewText(content);
  if (!normalized) {
    return DEFAULT_CHAT_TITLE();
  }

  if (normalized === t('host.imagePlaceholder')) {
    return t('host.imageConversationTitle');
  }

  return truncateSessionPreviewText(normalized, CHAT_TITLE_MAX_LENGTH);
}

async function generateChatTitleWithAI(
  chat: ChatFile,
  keyConfig: KeyFileConfig,
  options: ResolveTitleGenerationRequestConfigOptions = {}
): Promise<string> {
  const sourceContent = getChatTitleSourceContent(chat);
  if (!sourceContent) {
    throw new Error(t('host.titleNoUserMessageYet'));
  }

  const config = resolveTitleGenerationRequestConfig(chat, keyConfig, options);
  const rawTitle = await requestGeneratedChatTitle(config, createTitleGenerationContext(chat, sourceContent));
  const normalizedTitle = normalizeGeneratedChatTitle(rawTitle);
  if (!normalizedTitle) {
    throw new Error(t('host.titleModelEmpty'));
  }

  return normalizedTitle;
}

async function generateChatTitleBestEffort(
  chat: ChatFile,
  keyConfig: KeyFileConfig,
  fallbackContent: string,
  options: ResolveTitleGenerationRequestConfigOptions = {}
): Promise<string> {
  try {
    return await generateChatTitleWithAI(chat, keyConfig, options);
  } catch {
    return generateChatTitleFromContent(fallbackContent);
  }
}

function createTitleGenerationContext(chat: ChatFile, sourceContent: string): string {
  const activeMessages = getActiveConversationMessages(chat);
  const transcriptLines: string[] = [];
  let remainingChars = TITLE_GENERATION_MAX_CONTEXT_CHARS;

  for (const message of activeMessages) {
    if ((message.role !== 'user' && message.role !== 'assistant') || remainingChars <= 0) {
      continue;
    }

    const normalizedContent = normalizeSessionPreviewText(getMessageCurrentContent(message));
    if (!normalizedContent) {
      continue;
    }

    const prefix = message.role === 'user' ? t('host.titleGenerationRolePrefixUser') : t('host.titleGenerationRolePrefixAssistant');
    const line = `${prefix}: ${normalizedContent}`;
    const truncatedLine = truncateSessionPreviewText(
      line,
      Math.min(TITLE_GENERATION_MAX_CONTEXT_LINE_CHARS, remainingChars)
    );
    if (!truncatedLine) {
      break;
    }

    transcriptLines.push(truncatedLine);
    remainingChars -= truncatedLine.length + 1;
    if (transcriptLines.length >= TITLE_GENERATION_MAX_CONTEXT_MESSAGES) {
      break;
    }
  }

  if (transcriptLines.length === 0) {
    transcriptLines.push(t('host.titleGenerationTranscriptUser', { text: truncateSessionPreviewText(normalizeSessionPreviewText(sourceContent), TITLE_GENERATION_MAX_CONTEXT_LINE_CHARS) }));
  }

  return [
    t('host.titleGenerationUserHeader'),
    '',
    transcriptLines.join('\n')
  ].join('\n');
}

function normalizeGeneratedChatTitle(value: string): string {
  let normalized = value.replace(/\r?\n+/g, ' ');
  normalized = normalized.replace(/^#{1,6}\s*/, '');
  normalized = normalized.replace(/^[-*]\s+/, '');
  normalized = normalized.replace(new RegExp(t('host.titleGenerationStripPattern'), 'i'), '');
  normalized = normalized.replace(/^["'“‘《「『【(（\[]+/, '');
  normalized = normalized.replace(/["'”’》」』】)）\]]+$/, '');
  normalized = normalizeSessionPreviewText(normalized);

  if (!normalized) {
    return '';
  }

  if (normalized === t('host.imagePlaceholder')) {
    return t('host.imageConversationTitle');
  }

  return truncateSessionPreviewText(normalized, CHAT_TITLE_MAX_LENGTH);
}

async function createWebviewChatFile(
  webview: vscode.Webview,
  document: vscode.TextDocument,
  chat: ChatFile,
  keyConfig?: KeyFileConfig
): Promise<WebviewChatFile> {
  const activeMessages = getActiveConversationMessages(chat);

  return {
    ...chat,
    messages: await Promise.all(activeMessages.map((message) => createWebviewChatMessage(webview, document, chat, message, keyConfig)))
  };
}

async function createWebviewChatMessage(
  webview: vscode.Webview,
  document: vscode.TextDocument,
  chat: ChatFile,
  message: ChatMessage,
  keyConfig?: KeyFileConfig
): Promise<ChatMessage> {
  const siblingIds = getSiblingIds(chat, message.parentId);
  const branchIndex = siblingIds.indexOf(message.id);
  const currentContent = getMessageCurrentContent(message);
  const currentBody = getMessageCurrentBody(message);
  const currentAttachments = getMessageCurrentAttachments(message);

  const [contentHtml, contentParts, reasoningContentHtml, versions] = await Promise.all([
    renderMarkdownToHtml(currentContent),
    createWebviewContentParts(webview, document, currentBody, currentAttachments),
    renderMarkdownToHtml(message.reasoningContent),
    Promise.all(
      (message.versions ?? []).map(async (version) => {
        const assistantLabel = keyConfig
          ? resolveProjectedAssistantLabel(version, keyConfig)
          : version.assistantLabel;

        return {
          ...version,
          ...(assistantLabel !== undefined ? { assistantLabel } : {}),
          contentHtml: await renderMarkdownToHtml(version.content),
          contentParts: await createWebviewContentParts(webview, document, version.body, version.attachments ?? []),
          reasoningContentHtml: await renderMarkdownToHtml(version.reasoningContent)
        };
      })
    )
  ]);

  return {
    ...message,
    contentHtml,
    contentParts,
    reasoningContentHtml,
    branchCount: siblingIds.length > 0 ? siblingIds.length : 1,
    branchIndex: branchIndex >= 0 ? branchIndex + 1 : 1,
    versions: versions.length > 0 ? versions : undefined
  };
}

function createMarkdownRenderer(): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true
  });

  md.use(texmath, {
    engine: katex,
    delimiters: 'dollars',
    katexOptions: {
      throwOnError: false,
      strict: 'ignore',
      trust: false
    }
  });

  md.options.highlight = (code, info) => renderHighlightedCodeBlock(md, code, info);

  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx];

    const targetAttrIndex = token.attrIndex('target');
    if (targetAttrIndex < 0) {
      token.attrPush(['target', '_blank']);
    } else if (token.attrs) {
      token.attrs[targetAttrIndex][1] = '_blank';
    }

    const relAttrIndex = token.attrIndex('rel');
    if (relAttrIndex < 0) {
      token.attrPush(['rel', 'noopener noreferrer']);
    } else if (token.attrs) {
      token.attrs[relAttrIndex][1] = 'noopener noreferrer';
    }

    return self.renderToken(tokens, idx, options);
  };

  md.renderer.rules.image = (tokens, idx, options, _env, self) => {
    const token = tokens[idx];
    const loadingAttrIndex = token.attrIndex('loading');
    if (loadingAttrIndex < 0) {
      token.attrPush(['loading', 'lazy']);
    }

    const decodingAttrIndex = token.attrIndex('decoding');
    if (decodingAttrIndex < 0) {
      token.attrPush(['decoding', 'async']);
    }

    const classAttrIndex = token.attrIndex('class');
    if (classAttrIndex < 0) {
      token.attrPush(['class', 'chat-markdown-image']);
    } else if (token.attrs) {
      token.attrs[classAttrIndex][1] = `${token.attrs[classAttrIndex][1]} chat-markdown-image`.trim();
    }

    return self.renderToken(tokens, idx, options);
  };

  return md;
}

function renderHighlightedCodeBlock(md: MarkdownIt, source: string, info: string): string {
  const fenceLanguage = normalizeFenceLanguageInfo(info);

  let highlightedHtml = md.utils.escapeHtml(source);
  if (fenceLanguage.highlightLanguage) {
    try {
      highlightedHtml = hljs.highlight(source, { language: fenceLanguage.highlightLanguage, ignoreIllegals: true }).value;
    } catch {
      highlightedHtml = md.utils.escapeHtml(source);
    }
  }

  const className = fenceLanguage.className ? ` language-${fenceLanguage.className}` : '';
  const languageAttribute = fenceLanguage.displayLabel
    ? ` data-code-language="${md.utils.escapeHtml(fenceLanguage.displayLabel)}"`
    : '';

  return `<pre class="chat-markdown-code-block" data-code-block="true"${languageAttribute}><code class="hljs${className}">${highlightedHtml}</code></pre>`;
}

function normalizeFenceLanguageInfo(info: string): {
  displayLabel?: string;
  highlightLanguage?: string;
  className?: string;
} {
  const languageToken = typeof info === 'string' ? info.trim().split(/\s+/u)[0] ?? '' : '';
  if (!languageToken) {
    return {};
  }

  const normalizedLanguage = languageToken.toLowerCase();
  const className = normalizedLanguage.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

  return {
    displayLabel: languageToken,
    highlightLanguage: hljs.getLanguage(normalizedLanguage) ? normalizedLanguage : undefined,
    className: className || undefined
  };
}

async function renderMarkdownToHtml(source: string | undefined): Promise<string | undefined> {
  if (typeof source !== 'string' || !source.trim()) {
    return undefined;
  }

  try {
    const html = markdownRenderer.render(source).trim();
    return html || undefined;
  } catch {
    return undefined;
  }
}

async function openExternalMarkdownLink(href: string): Promise<void> {
  if (typeof href !== 'string' || !href.trim()) {
    return;
  }

  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(href, true);
  } catch {
    return;
  }

  if (!MARKDOWN_LINK_SCHEMES.has(uri.scheme.toLowerCase())) {
    return;
  }

  await vscode.env.openExternal(uri);
}

async function createWebviewContentParts(
  webview: vscode.Webview,
  document: vscode.TextDocument,
  body: ChatMessageBody,
  attachments: ChatAttachment[] = []
): Promise<WebviewChatContentPart[] | undefined> {
  if (!body.parts.some((part) => part.type === 'attachment_ref')) {
    return undefined;
  }

  const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const contentParts: WebviewChatContentPart[] = [];
  for (const part of body.parts) {
    if (part.type === 'text') {
      if (!part.text.trim()) {
        continue;
      }

      contentParts.push({
        type: 'text',
        text: part.text,
        html: await renderMarkdownToHtml(part.text)
      });
      continue;
    }

    const attachment = attachmentById.get(part.attachmentId);
    if (!attachment) {
      contentParts.push({
        type: 'text',
        text: t('host.attachmentLost'),
        html: await renderMarkdownToHtml(t('host.attachmentLost'))
      });
      continue;
    }

    if (attachment.kind !== 'image') {
      contentParts.push({
        type: 'file',
        attachmentId: attachment.id,
        label: attachment.originalName || path.posix.basename(attachment.assetPath),
        detail: `${attachment.mimeType || 'application/octet-stream'} · ${formatBytes(attachment.size)}`,
        relativePath: attachment.assetPath
      });
      continue;
    }

    try {
      const relativePath = normalizeStoredAssetPath(attachment.assetPath);
      const imageUri = await resolveAssetFileUri(document, relativePath);

      contentParts.push({
        type: 'image',
        attachmentId: attachment.id,
        alt: attachment.originalName || path.posix.basename(relativePath),
        relativePath,
        src: webview.asWebviewUri(imageUri).toString()
      });
    } catch {
      contentParts.push({
        type: 'text',
        text: t('host.imageLost', { label: attachment.originalName || attachment.assetPath }),
        html: await renderMarkdownToHtml(t('host.imageLost', { label: attachment.originalName || attachment.assetPath }))
      });
    }
  }

  return contentParts.length > 0 ? contentParts : undefined;
}

function hasMeaningfulMessageContent(content: string): boolean {
  return content.trim().length > 0;
}

async function composeUserMessageBody(
  document: vscode.TextDocument,
  prompt: string,
  attachments: ChatAttachment[]
): Promise<{ body: ChatMessageBody; attachments: ChatAttachment[]; content: string }> {
  const markdownBody = await parseLocalMarkdownAssetAttachments(document, prompt.trim());
  const parts: ChatMessageBodyPart[] = [...markdownBody.parts];
  const allAttachments = [...markdownBody.attachments, ...attachments];
  const trimmedPrompt = prompt.trim();

  if (trimmedPrompt && markdownBody.parts.length === 0) {
    appendTextBodyPart(parts, trimmedPrompt);
  }

  for (const attachment of attachments) {
    if (parts.length > 0) {
      appendTextBodyPart(parts, '\n');
    }
    parts.push({ type: 'attachment_ref', attachmentId: attachment.id });
  }

  const body = createChatMessageBody(parts);
  const content = getBodyPlainText(body, allAttachments);
  if (!content.trim() && allAttachments.length === 0) {
    throw new Error(t('host.messageContentRequired'));
  }

  return { body, attachments: allAttachments, content };
}

const LOCAL_MARKDOWN_ASSET_LINK_REGEX = /(!?)\[([^\]\r\n]*)\]\(([^)\r\n]+)\)/g;

async function parseLocalMarkdownAssetAttachments(
  document: vscode.TextDocument,
  prompt: string
): Promise<{ parts: ChatMessageBodyPart[]; attachments: ChatAttachment[] }> {
  if (!prompt) {
    return { parts: [], attachments: [] };
  }

  const parts: ChatMessageBodyPart[] = [];
  const attachments: ChatAttachment[] = [];
  let cursor = 0;

  for (const match of prompt.matchAll(LOCAL_MARKDOWN_ASSET_LINK_REGEX)) {
    const rawDestination = match[3] ?? '';
    const assetPath = normalizePastedMarkdownAssetPath(rawDestination);
    if (!assetPath) {
      continue;
    }

    const attachment = await createAttachmentFromStoredAsset(
      document,
      assetPath,
      unescapeMarkdownLabel(match[2] ?? '')
    );
    appendTextBodyPart(parts, prompt.slice(cursor, match.index));
    parts.push({ type: 'attachment_ref', attachmentId: attachment.id });
    attachments.push(attachment);
    cursor = (match.index ?? 0) + match[0].length;
  }

  if (attachments.length === 0) {
    return { parts: [], attachments: [] };
  }

  appendTextBodyPart(parts, prompt.slice(cursor));
  return { parts, attachments };
}

async function createClipboardMarkdownAttachmentImport(
  document: vscode.TextDocument,
  text: string
): Promise<{ text: string; attachments: WebviewIncomingAttachment[] }> {
  if (!text) {
    return { text, attachments: [] };
  }

  const textParts: string[] = [];
  const attachments: WebviewIncomingAttachment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(LOCAL_MARKDOWN_ASSET_LINK_REGEX)) {
    const assetPath = normalizePastedMarkdownAssetPath(match[3] ?? '');
    if (!assetPath) {
      continue;
    }

    const attachment = await createWebviewIncomingAttachmentFromStoredAsset(
      document,
      assetPath,
      unescapeMarkdownLabel(match[2] ?? '')
    );
    textParts.push(text.slice(cursor, match.index));
    attachments.push(attachment);
    cursor = (match.index ?? 0) + match[0].length;
  }

  if (attachments.length === 0) {
    return { text, attachments: [] };
  }

  textParts.push(text.slice(cursor));
  const importedText = textParts.join('');
  return { text: importedText.trim() ? importedText : '', attachments };
}

function appendTextBodyPart(parts: ChatMessageBodyPart[], text: string | undefined): void {
  if (!text) {
    return;
  }

  const previousPart = parts[parts.length - 1];
  if (previousPart?.type === 'text') {
    previousPart.text += text;
    return;
  }

  parts.push({ type: 'text', text });
}

function normalizeChatMessageBodyParts(parts: ChatMessageBodyPart[]): ChatMessageBodyPart[] {
  const normalizedParts: ChatMessageBodyPart[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      appendTextBodyPart(normalizedParts, part.text);
      continue;
    }

    normalizedParts.push(part);
  }

  return normalizedParts;
}

function createChatMessageBody(parts: ChatMessageBodyPart[]): ChatMessageBody {
  return { parts: normalizeChatMessageBodyParts(parts) };
}

function normalizePastedMarkdownAssetPath(rawDestination: string): string | undefined {
  let destination = normalizeMarkdownLinkDestination(rawDestination);
  if (!destination) {
    return undefined;
  }

  destination = destination.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const expectedPrefix = `${CHAT_DIRECTORY_NAME}/${CHAT_ASSETS_DIRECTORY_NAME}/`;
  if (!destination.startsWith(expectedPrefix)) {
    return undefined;
  }

  const normalizedPath = normalizeStoredAssetPath(destination);
  return normalizedPath;
}

function normalizeMarkdownLinkDestination(rawDestination: string): string {
  let destination = rawDestination.trim();
  if (!destination) {
    return '';
  }

  if (destination.startsWith('<') && destination.endsWith('>')) {
    destination = destination.slice(1, -1).trim();
  } else {
    destination = destination.split(/\s+/)[0] ?? '';
  }

  try {
    return decodeURI(destination);
  } catch {
    return destination;
  }
}

async function createWebviewIncomingAttachmentFromStoredAsset(
  document: vscode.TextDocument,
  assetPath: string,
  originalNameHint: string
): Promise<WebviewIncomingAttachment> {
  const normalizedPath = normalizeStoredAssetPath(assetPath);
  const mimeType = getMimeTypeForAssetPath(normalizedPath);
  const assetUri = await resolveAssetFileUri(document, normalizedPath);
  const bytes = await vscode.workspace.fs.readFile(assetUri);
  const originalName = normalizeAttachmentOriginalName(
    originalNameHint || path.posix.basename(normalizedPath),
    mimeType,
    inferAttachmentKind(originalNameHint || normalizedPath, mimeType)
  );

  return {
    dataUrl: createAttachmentDataUrl(mimeType, bytes),
    mimeType,
    name: originalName,
    size: bytes.byteLength
  };
}

async function createAttachmentFromStoredAsset(
  document: vscode.TextDocument,
  assetPath: string,
  originalNameHint: string
): Promise<ChatAttachment> {
  const normalizedPath = normalizeStoredAssetPath(assetPath);
  const mimeType = getMimeTypeForAssetPath(normalizedPath);
  const assetUri = await resolveAssetFileUri(document, normalizedPath);
  const bytes = await vscode.workspace.fs.readFile(assetUri);
  const kind = inferAttachmentKind(originalNameHint || normalizedPath, mimeType);
  const originalName = normalizeAttachmentOriginalName(
    originalNameHint || path.posix.basename(normalizedPath),
    mimeType,
    kind
  );

  return createChatAttachmentFromBytes(kind, normalizedPath, originalName, mimeType, bytes);
}

async function createMessageBodyFromAssistantContent(
  document: vscode.TextDocument,
  content: string
): Promise<{ body: ChatMessageBody; attachments: ChatAttachment[]; content: string }> {
  if (!content) {
    return { body: createTextMessageBody(''), attachments: [], content: '' };
  }

  const parts: ChatMessageBodyPart[] = [];
  const attachments: ChatAttachment[] = [];
  let cursor = 0;

  for (const match of content.matchAll(LOCAL_MARKDOWN_ASSET_LINK_REGEX)) {
    if (match[1] !== '!') {
      continue;
    }

    const attachment = await createAssistantImageAttachmentFromMarkdownDestination(
      document,
      match[3] ?? '',
      unescapeMarkdownLabel(match[2] ?? '')
    );
    if (!attachment) {
      continue;
    }

    appendTextBodyPart(parts, content.slice(cursor, match.index));
    parts.push({ type: 'attachment_ref', attachmentId: attachment.id });
    attachments.push(attachment);
    cursor = (match.index ?? 0) + match[0].length;
  }

  if (attachments.length === 0) {
    return { body: createTextMessageBody(content), attachments: [], content };
  }

  appendTextBodyPart(parts, content.slice(cursor));
  const body = createChatMessageBody(parts);
  return { body, attachments, content: createClipboardMarkdownForBody(body, attachments) };
}

async function createAssistantImageAttachmentFromMarkdownDestination(
  document: vscode.TextDocument,
  rawDestination: string,
  label: string
): Promise<ChatAttachment | undefined> {
  const localAssetPath = normalizePastedMarkdownAssetPath(rawDestination);
  if (localAssetPath) {
    const attachment = await createAttachmentFromStoredAsset(document, localAssetPath, label);
    return attachment.kind === 'image' ? attachment : undefined;
  }

  const destination = normalizeMarkdownLinkDestination(rawDestination);
  if (!destination) {
    return undefined;
  }

  if (destination.toLowerCase().startsWith('data:')) {
    return createAssistantImageAttachmentFromDataUrl(document, destination, label);
  }

  if (/^https?:\/\//i.test(destination)) {
    return fetchAssistantImageAttachment(document, destination, label);
  }

  return undefined;
}

async function createAssistantImageAttachmentFromDataUrl(
  document: vscode.TextDocument,
  dataUrl: string,
  label: string
): Promise<ChatAttachment | undefined> {
  try {
    const parsed = parseAttachmentDataUrl(dataUrl);
    const name = createAssistantImageName(label, 'assistant-image', parsed.mimeType);
    const mimeType = normalizeAttachmentMimeType(name, parsed.mimeType);
    if (inferAttachmentKind(name, mimeType) !== 'image') {
      return undefined;
    }

    return persistAttachmentBytes(document, name, mimeType, parsed.bytes, 'image');
  } catch {
    return undefined;
  }
}

async function fetchAssistantImageAttachment(
  document: vscode.TextDocument,
  href: string,
  label: string
): Promise<ChatAttachment | undefined> {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), ASSISTANT_IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: abortController.signal });
    if (!response.ok) {
      return undefined;
    }

    const declaredMimeType = normalizeMimeType(response.headers.get('content-type') ?? undefined);
    const name = createAssistantImageName(label, path.posix.basename(url.pathname), declaredMimeType);
    const mimeType = normalizeAttachmentMimeType(name, declaredMimeType);
    if (inferAttachmentKind(name, mimeType) !== 'image') {
      return undefined;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    return persistAttachmentBytes(document, name, mimeType, bytes, 'image');
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function createAssistantImageName(label: string, fallbackName: string, mimeType: string): string {
  const candidate = sanitizeMarkdownLabel(label) !== 'attachment'
    ? sanitizeMarkdownLabel(label)
    : sanitizeMarkdownLabel(fallbackName) !== 'attachment'
      ? sanitizeMarkdownLabel(fallbackName)
      : 'assistant-image';
  return normalizeAttachmentOriginalName(candidate, normalizeMimeType(mimeType), 'image');
}

function getChatDirectoryUri(document: vscode.TextDocument): vscode.Uri {
  return vscode.Uri.file(path.dirname(document.uri.fsPath));
}

function getChatDataDirectoryUri(document: vscode.TextDocument): vscode.Uri {
  return getChatDataDirectoryUriForBaseDirectory(getChatDirectoryUri(document));
}

function getChatAssetsDirectoryUri(document: vscode.TextDocument): vscode.Uri {
  return vscode.Uri.joinPath(getChatDataDirectoryUri(document), CHAT_ASSETS_DIRECTORY_NAME);
}

function normalizeStoredAssetPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').trim();
  if (!normalized) {
    throw new Error(t('host.attachmentPathEmpty'));
  }

  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/') || normalized.startsWith('~')) {
    throw new Error(t('host.attachmentPathMustBeRelative', { path: relativePath }));
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(t('host.attachmentPathInvalid', { path: relativePath }));
  }

  const expectedPrefix = `${CHAT_DIRECTORY_NAME}/${CHAT_ASSETS_DIRECTORY_NAME}/`;
  if (!normalized.startsWith(expectedPrefix)) {
    throw new Error(t('host.attachmentPathMustBeUnder', { prefix: expectedPrefix, path: relativePath }));
  }

  return normalized;
}

async function resolveAssetFileUri(document: vscode.TextDocument, relativePath: string): Promise<vscode.Uri> {
  const normalizedPath = normalizeStoredAssetPath(relativePath);
  const resolution = await resolveChatDataDirectoryResolution(document.uri);

  for (const baseDirectoryUri of resolution.candidateBaseDirectories) {
    const candidateAssetUri = vscode.Uri.joinPath(baseDirectoryUri, ...normalizedPath.split('/'));
    if (await uriExists(candidateAssetUri)) {
      return candidateAssetUri;
    }
  }

  throw new Error(t('host.attachmentResourceNotFound', { path: normalizedPath }));
}

function getImageMimeTypeForPath(relativePath: string): string {
  const mimeType = getMimeTypeForAssetPath(relativePath);
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(t('host.unsupportedImageExtension', { path: relativePath }));
  }

  return mimeType;
}

function getMimeTypeForAssetPath(relativePath: string): string {
  return inferMimeTypeFromName(relativePath) ?? GENERIC_BINARY_MIME_TYPE;
}

function normalizeMimeType(value: string | undefined): string {
  const mimeType = typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
  return mimeType && mimeType.includes('/') ? mimeType : GENERIC_BINARY_MIME_TYPE;
}

function inferMimeTypeFromName(name: string): string | undefined {
  const mimeType = lookupMimeType(name);
  return mimeType ? normalizeMimeType(mimeType) : undefined;
}

function normalizeAttachmentMimeType(name: string, mimeType: string): string {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const inferredMimeType = inferMimeTypeFromName(name);

  if (!inferredMimeType) {
    return normalizedMimeType;
  }

  return normalizedMimeType === GENERIC_BINARY_MIME_TYPE ? inferredMimeType : normalizedMimeType;
}

function inferAttachmentKind(name: string, mimeType: string): ChatAttachmentKind {
  const normalizedMimeType = normalizeAttachmentMimeType(name, mimeType);
  return SUPPORTED_IMAGE_MIME_TYPES.has(normalizedMimeType) ? 'image' : 'file';
}

function parseAttachmentDataUrl(dataUrl: string): { bytes: Uint8Array; mimeType: string } {
  const match = /^data:([^,]*),([\s\S]*)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error(t('host.attachmentDataNotDataUrl'));
  }

  const metadataParts = (match[1] ?? '').split(';').map((part) => part.trim()).filter(Boolean);
  if (!metadataParts.some((part) => part.toLowerCase() === 'base64')) {
    throw new Error(t('host.attachmentDataMustBeBase64'));
  }

  const mimeType = normalizeMimeType(metadataParts.find((part) => part.includes('/')));
  const bytes = Buffer.from((match[2] ?? '').replace(/\s+/g, ''), 'base64');
  if (bytes.byteLength === 0) {
    throw new Error(t('host.attachmentContentEmpty'));
  }

  return { bytes, mimeType };
}

function createImageDataUrl(mimeType: string, bytes: Uint8Array): string {
  return createAttachmentDataUrl(mimeType, bytes);
}

function createAttachmentDataUrl(mimeType: string, bytes: Uint8Array): string {
  const base64 = toBuffer(bytes).toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function normalizeAttachmentOriginalName(name: string, mimeType: string, kind: ChatAttachmentKind): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  const fallback = kind === 'image' ? 'image' : 'file';
  const baseName = path.basename(trimmed || fallback).replace(/[\r\n]+/g, ' ').trim() || fallback;
  if (path.extname(baseName)) {
    return baseName;
  }

  return `${baseName}.${getAttachmentExtension(baseName, mimeType, kind)}`;
}

function getAttachmentExtension(originalName: string, mimeType: string, kind: ChatAttachmentKind): string {
  const nameExtension = path.extname(originalName).slice(1).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (nameExtension) {
    return nameExtension;
  }

  if (kind === 'image') {
    return SUPPORTED_IMAGE_MIME_TYPES.get(mimeType) ?? 'png';
  }

  const mimeExtension = getMimeExtension(normalizeMimeType(mimeType));
  if (mimeExtension) {
    return mimeExtension.replace(/[^a-z0-9]+/g, '') || 'bin';
  }

  return 'bin';
}

function createChatAttachment(
  kind: ChatAttachmentKind,
  assetPath: string,
  originalName: string,
  mimeType: string,
  bytes: Uint8Array,
  sha256: string
): ChatAttachment {
  return {
    id: `att-${crypto.randomUUID()}`,
    kind,
    assetPath,
    originalName,
    mimeType,
    size: bytes.byteLength,
    sha256,
    createdAt: new Date().toISOString()
  };
}

function createChatAttachmentFromBytes(
  kind: ChatAttachmentKind,
  assetPath: string,
  originalName: string,
  mimeType: string,
  bytes: Uint8Array
): ChatAttachment {
  if (kind === 'image' && !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(t('host.unsupportedImageFormat', { mime: mimeType }));
  }

  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  return createChatAttachment(kind, assetPath, originalName, mimeType, bytes, hash);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return '0 B';
  }

  if (value < 1024) {
    return `${Math.trunc(value)} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  for (const unit of units) {
    if (size < 1024 || unit === units[units.length - 1]) {
      return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
    }
    size /= 1024;
  }

  return `${Math.trunc(value)} B`;
}

async function isTextualAttachment(attachment: ChatAttachment, bytes: Uint8Array): Promise<boolean> {
  const buffer = toBuffer(bytes);
  const isTextFile = await getIsTextFile();
  const detectedText = isTextFile(attachment.originalName || attachment.assetPath, buffer);
  if (detectedText !== null) {
    return detectedText;
  }

  const mimeType = normalizeMimeType(attachment.mimeType);
  return mimeType.startsWith('text/') || mimeType.endsWith('+json') || mimeType.endsWith('+xml');
}

function getIsTextFile(): Promise<IsTextFileFunction> {
  isTextFileLoader ??= import('istextorbinary').then((module) => {
    const typedModule = module as unknown as { isText: IsTextFileFunction };
    return typedModule.isText;
  });
  return isTextFileLoader;
}

async function persistWebviewAttachments(
  document: vscode.TextDocument,
  attachments: WebviewIncomingAttachment[]
): Promise<ChatAttachment[]> {
  if (attachments.length === 0) {
    return [];
  }

  const assetsDirectoryUri = getChatAssetsDirectoryUri(document);
  await vscode.workspace.fs.createDirectory(assetsDirectoryUri);

  const storedAttachments: ChatAttachment[] = [];
  for (const attachment of attachments) {
    storedAttachments.push(await persistWebviewAttachment(document, attachment));
  }

  return storedAttachments;
}

async function persistWebviewAttachment(
  document: vscode.TextDocument,
  attachment: WebviewIncomingAttachment
): Promise<ChatAttachment> {
  const parsed = parseAttachmentDataUrl(attachment.dataUrl);
  const declaredMimeType = typeof attachment.mimeType === 'string' ? attachment.mimeType.trim().toLowerCase() : '';
  if (
    declaredMimeType
    && normalizeMimeType(declaredMimeType) !== normalizeMimeType(parsed.mimeType)
    && normalizeMimeType(declaredMimeType) !== GENERIC_BINARY_MIME_TYPE
    && normalizeMimeType(parsed.mimeType) !== GENERIC_BINARY_MIME_TYPE
  ) {
    throw new Error(t('host.attachmentMimeMismatch', { name: attachment.name || t('host.unnamedAttachment') }));
  }

  if (
    typeof attachment.size === 'number'
    && Number.isFinite(attachment.size)
    && attachment.size > 0
    && attachment.size !== parsed.bytes.byteLength
  ) {
    throw new Error(t('host.attachmentSizeMismatch', { name: attachment.name || t('host.unnamedAttachment') }));
  }

  const mimeType = normalizeAttachmentMimeType(
    attachment.name,
    normalizeMimeType(parsed.mimeType) === GENERIC_BINARY_MIME_TYPE && declaredMimeType ? declaredMimeType : parsed.mimeType
  );
  const kind = inferAttachmentKind(attachment.name, mimeType);
  return persistAttachmentBytes(document, attachment.name, mimeType, parsed.bytes, kind);
}

async function persistAttachmentBytes(
  document: vscode.TextDocument,
  name: string,
  mimeType: string,
  bytes: Uint8Array,
  kind: ChatAttachmentKind = inferAttachmentKind(name, mimeType)
): Promise<ChatAttachment> {
  const originalName = normalizeAttachmentOriginalName(name, mimeType, kind);
  if (kind === 'image' && !SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(t('host.unsupportedImageFormat', { mime: mimeType }));
  }

  const extension = getAttachmentExtension(originalName, mimeType, kind);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const assetsDirectoryUri = getChatAssetsDirectoryUri(document);
  await vscode.workspace.fs.createDirectory(assetsDirectoryUri);

  for (let collisionIndex = 0; collisionIndex < 1000; collisionIndex += 1) {
    const suffix = collisionIndex === 0 ? '' : `-${collisionIndex}`;
    const fileName = `sha256-${hash}${suffix}.${extension}`;
    const fileUri = vscode.Uri.joinPath(assetsDirectoryUri, fileName);

    try {
      const existingBytes = await vscode.workspace.fs.readFile(fileUri);
      if (toBuffer(existingBytes).equals(toBuffer(bytes))) {
        return createChatAttachment(kind, `${CHAT_DIRECTORY_NAME}/${CHAT_ASSETS_DIRECTORY_NAME}/${fileName}`, originalName, mimeType, bytes, hash);
      }

      continue;
    } catch {
      await vscode.workspace.fs.writeFile(fileUri, bytes);
      return createChatAttachment(kind, `${CHAT_DIRECTORY_NAME}/${CHAT_ASSETS_DIRECTORY_NAME}/${fileName}`, originalName, mimeType, bytes, hash);
    }
  }

  throw new Error(t('host.attachmentNameConflictTooMany', { name: originalName }));
}

async function validateConversationAttachmentReferences(document: vscode.TextDocument, messages: ChatMessage[]): Promise<void> {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }

    await validateMessageAttachmentReferences(document, message);
  }
}

async function validateMessageAttachmentReferences(document: vscode.TextDocument, message: ChatMessage): Promise<void> {
  const body = getMessageCurrentBody(message);
  const attachments = getMessageCurrentAttachments(message);
  const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const referencedAttachmentIds = body.parts
    .filter((part): part is Extract<ChatMessageBodyPart, { type: 'attachment_ref' }> => part.type === 'attachment_ref')
    .map((part) => part.attachmentId);

  const missingId = referencedAttachmentIds.find((attachmentId) => !attachmentById.has(attachmentId));
  if (missingId) {
    throw new Error(t('host.attachmentReferenceMissing', { id: missingId }));
  }

  for (const attachmentId of referencedAttachmentIds) {
    const attachment = attachmentById.get(attachmentId);
    if (!attachment) {
      continue;
    }

    const assetPath = normalizeStoredAssetPath(attachment.assetPath);
    const assetUri = await resolveAssetFileUri(document, assetPath);
    await vscode.workspace.fs.stat(assetUri);

    if (attachment.kind === 'image') {
      getImageMimeTypeForPath(assetPath);
    }
  }
}

function safeParseChatDocument(text: string, fallbackTitle: string): { chat: ChatFile; error?: string } {
  try {
    return {
      chat: parseChatDocument(text, fallbackTitle)
    };
  } catch (error) {
    return {
      chat: createEmptyChatFile(fallbackTitle),
      error: toErrorMessage(error)
    };
  }
}

function parseChatDocument(text: string, fallbackTitle: string): ChatFile {
  const normalizedText = text.replace(/^\uFEFF/, '');

  if (!normalizedText.trim()) {
    return createEmptyChatFile(fallbackTitle);
  }

  const raw = JSON.parse(normalizedText) as unknown;
  if (!isObject(raw)) {
    throw new Error(t('host.chatFileRootMustBeObject'));
  }

  const compatibleRaw = applyLegacyChatCompatibility(raw);

  if (compatibleRaw.version !== CHAT_FILE_VERSION) {
    throw new Error(t('host.chatFileVersionMustBe', { version: CHAT_FILE_VERSION }));
  }

  if (!Array.isArray(compatibleRaw.messages)) {
    throw new Error(t('host.chatFileMessagesMustBeArray'));
  }

  const parsedMessages = compatibleRaw.messages
    .map((value: unknown) => normalizeMessage(value))
    .filter((value: unknown): value is ChatMessage => value !== undefined);

  const normalizedTree = normalizeChatTree(compatibleRaw as Record<string, any>, parsedMessages);
  const createdAt = normalizeTimestamp(compatibleRaw.createdAt) ?? new Date().toISOString();
  const updatedAt = normalizeTimestamp(compatibleRaw.updatedAt) ?? createdAt;

  return {
    version: CHAT_FILE_VERSION,
    title: typeof compatibleRaw.title === 'string' && compatibleRaw.title.trim() ? compatibleRaw.title.trim() : fallbackTitle,
    createdAt,
    updatedAt,
    rootMessageIds: normalizedTree.rootMessageIds,
    activeChildByParentId: normalizedTree.activeChildByParentId,
    messages: normalizedTree.messages,
    commonConfigId: normalizeOptionalStringOrNull(compatibleRaw.commonConfigId),
    systemPrompt: normalizeInheritableTextField(compatibleRaw.systemPrompt),
    messageTemplate: normalizeInheritableTextField(compatibleRaw.messageTemplate),
    modelSelection: normalizeModelSelectionField(compatibleRaw.modelSelection)
  };
}

function normalizeMessage(raw: unknown): ChatMessage | undefined {
  if (!isObject(raw)) {
    return undefined;
  }

  const role = typeof raw.role === 'string' ? raw.role : undefined;
  if (role !== 'system' && role !== 'user' && role !== 'assistant') {
    return undefined;
  }

  const createdAt = normalizeTimestamp(raw.createdAt) ?? new Date().toISOString();
  const status = normalizeMessageStatus(raw.status) ?? 'completed';
  const rawReasoningContent = typeof raw.reasoningContent === 'string' ? raw.reasoningContent : undefined;
  const rawThinkingDurationMs = normalizeDurationMs(raw.thinkingDurationMs);
  const rawTotalDurationMs = normalizeDurationMs(raw.totalDurationMs);
  const rawTokenStats = normalizeTokenStats(raw.tokenStats);

  const rawModel = typeof raw.model === 'string' && raw.model.trim()
    ? raw.model.trim()
    : typeof raw.modelId === 'string' && raw.modelId.trim()
      ? raw.modelId.trim()
      : undefined;

  const rawProviderId = typeof raw.providerId === 'string' && raw.providerId.trim()
    ? raw.providerId.trim()
    : typeof raw.provider === 'string' && raw.provider.trim()
      ? raw.provider.trim()
      : undefined;

  const rawOptionId = typeof raw.optionId === 'string' && raw.optionId.trim()
    ? raw.optionId.trim()
    : undefined;

  const rawAssistantLabel = typeof raw.assistantLabel === 'string' && raw.assistantLabel.trim()
    ? raw.assistantLabel.trim()
    : undefined;

  const versions = normalizeMessageVersions(raw.versions, createdAt, status, {
    reasoningContent: rawReasoningContent,
    thinkingDurationMs: rawThinkingDurationMs,
    totalDurationMs: rawTotalDurationMs,
    tokenStats: rawTokenStats,
    model: rawModel,
    providerId: rawProviderId,
    optionId: rawOptionId,
    assistantLabel: rawAssistantLabel
  });

  const currentVersionId = normalizeCurrentVersionId(raw.currentVersionId, versions);
  const currentVersion = getVersionById(versions, currentVersionId);
  const content = currentVersion?.content;

  if (typeof content !== 'string') {
    return undefined;
  }

  const body = currentVersion?.body ?? createTextMessageBody(content);
  const attachments = currentVersion?.attachments;

  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : crypto.randomUUID(),
    role,
    content,
    body,
    attachments,
    currentVersionId,
    createdAt,
    parentId: typeof raw.parentId === 'string' && raw.parentId.trim() ? raw.parentId : undefined,
    childIds: normalizeChildIds(raw.childIds),
    model: currentVersion?.model ?? rawModel,
    providerId: currentVersion?.providerId ?? rawProviderId,
    optionId: currentVersion?.optionId ?? rawOptionId,
    reasoningContent: currentVersion?.reasoningContent ?? rawReasoningContent,
    thinkingDurationMs: currentVersion?.thinkingDurationMs ?? rawThinkingDurationMs,
    totalDurationMs: currentVersion?.totalDurationMs ?? rawTotalDurationMs,
    tokenStats: currentVersion?.tokenStats ?? rawTokenStats,
    status,
    errorDetail: typeof raw.errorDetail === 'string' && raw.errorDetail.trim() ? raw.errorDetail : undefined,
    versions
  };
}

function normalizeChildIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const childIds = raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return childIds.length > 0 ? childIds : undefined;
}

function normalizeChatTree(
  raw: Record<string, any>,
  messages: ChatMessage[]
): Pick<ChatFile, 'messages' | 'rootMessageIds' | 'activeChildByParentId'> {
  const rawRootMessageIds = Array.isArray(raw.rootMessageIds) ? raw.rootMessageIds : [];
  const messageMap = new Map<string, ChatMessage>();
  const orderedMessages: ChatMessage[] = [];

  for (const message of messages) {
    if (messageMap.has(message.id)) {
      continue;
    }

    const clonedMessage: ChatMessage = {
      ...message,
      childIds: []
    };

    if (clonedMessage.parentId === clonedMessage.id) {
      clonedMessage.parentId = undefined;
    }

    messageMap.set(clonedMessage.id, clonedMessage);
    orderedMessages.push(clonedMessage);
  }

  for (const message of orderedMessages) {
    if (message.parentId && !messageMap.has(message.parentId)) {
      message.parentId = undefined;
    }
  }

  for (const message of orderedMessages) {
    if (!message.parentId) {
      continue;
    }

    const parent = messageMap.get(message.parentId);
    if (!parent || parent.id === message.id) {
      message.parentId = undefined;
      continue;
    }

    parent.childIds = parent.childIds ?? [];
    if (!parent.childIds.includes(message.id)) {
      parent.childIds.push(message.id);
    }
  }

  const rootMessageIds = rawRootMessageIds.filter((messageId: unknown, index: number, messageIds: unknown[]) => {
    if (typeof messageId !== 'string') {
      return false;
    }

    const message = messageMap.get(messageId);
    return !!message && !message.parentId && messageIds.indexOf(messageId) === index;
  });

  for (const message of orderedMessages) {
    if (!message.parentId && !rootMessageIds.includes(message.id)) {
      rootMessageIds.push(message.id);
    }
  }

  const activeChildByParentId: Record<string, string> = isObject(raw.activeChildByParentId)
    ? Object.fromEntries(
        Object.entries(raw.activeChildByParentId).filter(
          (entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'
        )
      )
    : {};

  ensureActiveSelection(activeChildByParentId, ROOT_BRANCH_PARENT_ID, rootMessageIds);
  for (const message of orderedMessages) {
    ensureActiveSelection(activeChildByParentId, message.id, message.childIds ?? []);
  }

  return {
    messages: orderedMessages,
    rootMessageIds,
    activeChildByParentId
  };
}

function ensureActiveSelection(activeChildByParentId: Record<string, string>, parentKey: string, childIds: string[]): void {
  if (childIds.length === 0) {
    delete activeChildByParentId[parentKey];
    return;
  }

  if (!childIds.includes(activeChildByParentId[parentKey])) {
    activeChildByParentId[parentKey] = childIds[childIds.length - 1];
  }
}

function getMessageMap(chat: ChatFile): Map<string, ChatMessage> {
  return new Map(chat.messages.map((message) => [message.id, message]));
}

function getBranchParentKey(parentId: string | undefined): string {
  return parentId ?? ROOT_BRANCH_PARENT_ID;
}

function getActiveChildSelectionId(
  chat: Pick<ChatFile, 'activeChildByParentId'>,
  parentId: string | undefined
): string | undefined {
  return chat.activeChildByParentId[getBranchParentKey(parentId)];
}

function withActiveChildSelection(
  activeChildByParentId: Record<string, string>,
  parentId: string | undefined,
  messageId: string
): Record<string, string> {
  return {
    ...activeChildByParentId,
    [getBranchParentKey(parentId)]: messageId
  };
}

function getSiblingIds(chat: ChatFile, parentId: string | undefined): string[] {
  if (!parentId) {
    return [...chat.rootMessageIds];
  }

  const messageMap = getMessageMap(chat);
  return [...(messageMap.get(parentId)?.childIds ?? [])];
}

function getSelectedChildId(chat: ChatFile, parentId: string | undefined, childIds: string[]): string | undefined {
  if (childIds.length === 0) {
    return undefined;
  }

  const selectedId = getActiveChildSelectionId(chat, parentId);
  return selectedId && childIds.includes(selectedId) ? selectedId : childIds[childIds.length - 1];
}

function getActiveConversationMessages(chat: ChatFile): ChatMessage[] {
  const messageMap = getMessageMap(chat);
  const activeMessages: ChatMessage[] = [];
  const visited = new Set<string>();
  let parentId: string | undefined;

  while (true) {
    const childIds = parentId ? messageMap.get(parentId)?.childIds ?? [] : chat.rootMessageIds;
    const selectedChildId = getSelectedChildId(chat, parentId, childIds);

    if (!selectedChildId || visited.has(selectedChildId)) {
      break;
    }

    const nextMessage = messageMap.get(selectedChildId);
    if (!nextMessage) {
      break;
    }

    activeMessages.push(nextMessage);
    visited.add(nextMessage.id);
    parentId = nextMessage.id;
  }

  return activeMessages;
}

function getConversationPathToMessage(chat: ChatFile, messageId: string): ChatMessage[] {
  const messageMap = getMessageMap(chat);
  const visited = new Set<string>();
  const pathToRoot: ChatMessage[] = [];

  let current = messageMap.get(messageId);
  while (current && !visited.has(current.id)) {
    pathToRoot.push(current);
    visited.add(current.id);
    current = current.parentId ? messageMap.get(current.parentId) : undefined;
  }

  return pathToRoot.reverse();
}

function activateMessagePath(chat: ChatFile, messageId: string): ChatFile {
  const chain = getConversationPathToMessage(chat, messageId);
  if (chain.length === 0) {
    return chat;
  }

  let nextActiveChildByParentId = { ...chat.activeChildByParentId };
  nextActiveChildByParentId = withActiveChildSelection(nextActiveChildByParentId, undefined, chain[0].id);

  for (let index = 1; index < chain.length; index += 1) {
    nextActiveChildByParentId = withActiveChildSelection(nextActiveChildByParentId, chain[index - 1].id, chain[index].id);
  }

  return {
    ...chat,
    updatedAt: new Date().toISOString(),
    activeChildByParentId: nextActiveChildByParentId
  };
}

function normalizeMessageVersions(
  raw: unknown,
  fallbackSavedAt: string,
  status: ChatMessageStatus | undefined,
  fallbackExtras?: {
    reasoningContent?: string;
    thinkingDurationMs?: number;
    totalDurationMs?: number;
    tokenStats?: ChatTokenStats;
    model?: string;
    providerId?: string;
    optionId?: string;
    assistantLabel?: string;
  }
): ChatMessageVersion[] | undefined {
  if (!Array.isArray(raw)) {
    return status === 'pending' ? [createMessageVersion('', fallbackSavedAt, fallbackExtras)] : undefined;
  }

  const seenVersionIds = new Set<string>();
  const versions: ChatMessageVersion[] = [];

  for (const value of raw) {
    if (!isObject(value)) {
      continue;
    }

    const content = typeof value.content === 'string' ? value.content : undefined;
    const body = normalizeMessageBody(value.body) ?? (content !== undefined ? createTextMessageBody(content) : undefined);
    if (!body) {
      continue;
    }

    const attachments = normalizeMessageAttachments(value.attachments);
    const normalizedContent = content ?? getBodyPlainText(body, attachments);

    const savedAt = normalizeTimestamp(value.savedAt) ?? fallbackSavedAt;

    let id = typeof value.id === 'string' && value.id.trim() ? value.id : crypto.randomUUID();
    if (seenVersionIds.has(id)) {
      id = crypto.randomUUID();
    }
    seenVersionIds.add(id);

    const reasoningContent = typeof value.reasoningContent === 'string' ? value.reasoningContent : undefined;
    const thinkingDurationMs = normalizeDurationMs(value.thinkingDurationMs);
    const totalDurationMs = normalizeDurationMs(value.totalDurationMs);
    const tokenStats = normalizeTokenStats(value.tokenStats);

    const model = typeof value.model === 'string' && value.model.trim()
      ? value.model.trim()
      : typeof value.modelId === 'string' && value.modelId.trim()
        ? value.modelId.trim()
        : undefined;

    const providerId = typeof value.providerId === 'string' && value.providerId.trim()
      ? value.providerId.trim()
      : typeof value.provider === 'string' && value.provider.trim()
        ? value.provider.trim()
        : undefined;

    const optionId = typeof value.optionId === 'string' && value.optionId.trim()
      ? value.optionId.trim()
      : undefined;

    const assistantLabel = typeof value.assistantLabel === 'string' && value.assistantLabel.trim()
      ? value.assistantLabel.trim()
      : fallbackExtras?.assistantLabel;

    const version: ChatMessageVersion = {
      id,
      content: normalizedContent,
      body,
      ...(attachments.length > 0 ? { attachments } : {}),
      savedAt,
      ...(reasoningContent !== undefined ? { reasoningContent } : {}),
      ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
      ...(totalDurationMs !== undefined ? { totalDurationMs } : {}),
      ...(tokenStats !== undefined ? { tokenStats } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(providerId !== undefined ? { providerId } : {}),
      ...(optionId !== undefined ? { optionId } : {}),
      ...(assistantLabel !== undefined ? { assistantLabel } : {})
    };

    versions.push(version);
  }

  if (versions.length > 0) {
    return versions;
  }

  return status === 'pending' ? [createMessageVersion('', fallbackSavedAt, fallbackExtras)] : undefined;
}

function normalizeMessageBody(raw: unknown): ChatMessageBody | undefined {
  if (!isObject(raw) || 'format' in raw || !Array.isArray(raw.parts)) {
    return undefined;
  }

  const parts: ChatMessageBodyPart[] = [];
  for (const value of raw.parts) {
    if (!isObject(value) || typeof value.type !== 'string') {
      continue;
    }

    if (value.type === 'text' && typeof value.text === 'string') {
      parts.push({ type: 'text', text: value.text });
      continue;
    }

    if (value.type === 'attachment_ref' && typeof value.attachmentId === 'string' && value.attachmentId.trim()) {
      parts.push({ type: 'attachment_ref', attachmentId: value.attachmentId.trim() });
    }
  }

  return createChatMessageBody(parts);
}

function normalizeMessageAttachments(raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const seenIds = new Set<string>();
  const attachments: ChatAttachment[] = [];
  for (const value of raw) {
    if (!isObject(value)) {
      continue;
    }

    const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : '';
    if (!id || seenIds.has(id)) {
      continue;
    }

    const kind = value.kind === 'image' || value.kind === 'file' ? value.kind : undefined;
    const assetPath = typeof value.assetPath === 'string' ? value.assetPath.trim() : '';
    const originalName = typeof value.originalName === 'string' && value.originalName.trim()
      ? value.originalName.trim()
      : path.posix.basename(assetPath) || 'attachment';
    const mimeType = typeof value.mimeType === 'string' && value.mimeType.trim()
      ? value.mimeType.trim().toLowerCase()
      : 'application/octet-stream';
    const size = typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0
      ? Math.trunc(value.size)
      : 0;
    const sha256 = typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256.trim())
      ? value.sha256.trim().toLowerCase()
      : '';
    const createdAt = normalizeTimestamp(value.createdAt) ?? new Date().toISOString();

    if (!kind || !assetPath || !sha256) {
      continue;
    }

    try {
      normalizeStoredAssetPath(assetPath);
    } catch {
      continue;
    }

    seenIds.add(id);
    attachments.push({ id, kind, assetPath, originalName, mimeType, size, sha256, createdAt });
  }

  return attachments;
}

function normalizeCurrentVersionId(raw: unknown, versions: Array<Pick<ChatMessageVersion, 'id'>> | undefined): string | undefined {
  if (!versions || versions.length === 0) {
    return undefined;
  }

  if (typeof raw === 'string' && versions.some((version) => version.id === raw)) {
    return raw;
  }

  return versions[versions.length - 1]?.id;
}

function getMessageCurrentVersion(
  message: Pick<ChatMessage, 'versions' | 'currentVersionId'>
): ChatMessageVersion | undefined {
  return getVersionById(message.versions, message.currentVersionId);
}

function getMessageCurrentContent(
  message: Pick<ChatMessage, 'content' | 'versions' | 'currentVersionId'>
): string {
  return getMessageCurrentVersion(message)?.content ?? message.content;
}

function getMessageCurrentBody(
  message: Pick<ChatMessage, 'body' | 'versions' | 'currentVersionId'>
): ChatMessageBody {
  return getMessageCurrentVersion(message)?.body ?? message.body;
}

function getMessageCurrentAttachments(
  message: Pick<ChatMessage, 'attachments' | 'versions' | 'currentVersionId'>
): ChatAttachment[] {
  return getMessageCurrentVersion(message)?.attachments ?? message.attachments ?? [];
}

function getMessageCurrentAssistantLabel(
  message: Pick<ChatMessage, 'versions' | 'currentVersionId'>
): string | undefined {
  return getMessageCurrentVersion(message)?.assistantLabel;
}

function isCurrentMessageContent(
  message: Pick<ChatMessage, 'content' | 'versions' | 'currentVersionId'>,
  content: string
): boolean {
  return getMessageCurrentContent(message) === content;
}

function isCurrentMessageVersion(
  message: Pick<ChatMessage, 'versions' | 'currentVersionId'>,
  versionId: string
): boolean {
  return getMessageCurrentVersion(message)?.id === versionId;
}

function getVersionById(
  versions: ChatMessageVersion[] | undefined,
  versionId: string | undefined
): ChatMessageVersion | undefined {
  if (!versions || versions.length === 0) {
    return undefined;
  }

  if (!versionId) {
    return versions[versions.length - 1];
  }

  return findVersionById(versions, versionId) ?? versions[versions.length - 1];
}

function findVersionById(
  versions: ChatMessageVersion[] | undefined,
  versionId: string | undefined
): ChatMessageVersion | undefined {
  if (!versions || versions.length === 0 || !versionId) {
    return undefined;
  }

  return versions.find((version) => version.id === versionId);
}

function createMessageVersion(
  content: string,
  savedAt: string = new Date().toISOString(),
  extras?: {
    reasoningContent?: string;
    thinkingDurationMs?: number;
    totalDurationMs?: number;
    tokenStats?: ChatTokenStats;
    model?: string;
    providerId?: string;
    optionId?: string;
    assistantLabel?: string;
  },
  body: ChatMessageBody = createTextMessageBody(content),
  attachments?: ChatAttachment[]
): ChatMessageVersion {
  const normalizedBody = createChatMessageBody(body.parts);
  return {
    id: crypto.randomUUID(),
    content,
    body: normalizedBody,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    savedAt,
    ...(extras?.reasoningContent !== undefined ? { reasoningContent: extras.reasoningContent } : {}),
    ...(extras?.thinkingDurationMs !== undefined ? { thinkingDurationMs: extras.thinkingDurationMs } : {}),
    ...(extras?.totalDurationMs !== undefined ? { totalDurationMs: extras.totalDurationMs } : {}),
    ...(extras?.tokenStats !== undefined ? { tokenStats: extras.tokenStats } : {}),
    ...(extras?.model !== undefined ? { model: extras.model } : {}),
    ...(extras?.providerId !== undefined ? { providerId: extras.providerId } : {}),
    ...(extras?.optionId !== undefined ? { optionId: extras.optionId } : {}),
    ...(extras?.assistantLabel !== undefined ? { assistantLabel: extras.assistantLabel } : {})
  };
}

function appendMessageVersion(
  message: ChatMessage,
  content: string,
  savedAt: string = new Date().toISOString(),
  body?: ChatMessageBody,
  attachments?: ChatAttachment[]
): ChatMessage {
  const nextVersion = createMessageVersion(
    content,
    savedAt,
    {
      reasoningContent: message.reasoningContent,
      thinkingDurationMs: message.thinkingDurationMs,
      totalDurationMs: message.totalDurationMs,
      tokenStats: message.tokenStats,
      model: message.model,
      providerId: message.providerId,
      optionId: message.optionId,
      assistantLabel: getMessageCurrentAssistantLabel(message)
    },
    body ?? createTextMessageBody(content),
    attachments
  );

  return {
    ...message,
    content,
    body: nextVersion.body,
    attachments: nextVersion.attachments,
    currentVersionId: nextVersion.id,
    versions: [...(message.versions ?? []), nextVersion]
  };
}

function setMessageCurrentVersion(message: ChatMessage, versionId: string): ChatMessage {
  const version = findVersionById(message.versions, versionId);
  if (!version) {
    return message;
  }

  return {
    ...message,
    content: version.content,
    body: version.body,
    attachments: version.attachments,
    currentVersionId: version.id,
    reasoningContent: version.reasoningContent,
    thinkingDurationMs: version.thinkingDurationMs,
    totalDurationMs: version.totalDurationMs,
    tokenStats: version.tokenStats,
    model: version.model,
    providerId: version.providerId,
    optionId: version.optionId
  };
}

function setMessageCurrentContent(
  message: ChatMessage,
  content: string,
  savedAt: string = new Date().toISOString(),
  versionExtras?: {
    reasoningContent?: string;
    thinkingDurationMs?: number;
    totalDurationMs?: number;
    tokenStats?: ChatTokenStats;
    model?: string;
    providerId?: string;
    optionId?: string;
    assistantLabel?: string;
  }
): ChatMessage {
  const versions = [...(message.versions ?? [])];
  const currentVersionId = normalizeCurrentVersionId(message.currentVersionId, versions);
  const currentVersionIndex = currentVersionId ? versions.findIndex((version) => version.id === currentVersionId) : -1;

  if (currentVersionIndex < 0) {
    const nextVersion = createMessageVersion(content, savedAt, versionExtras);
    return {
      ...message,
      content,
      body: nextVersion.body,
      attachments: nextVersion.attachments,
      currentVersionId: nextVersion.id,
      versions: [...versions, nextVersion]
    };
  }

  const currentVersion = versions[currentVersionIndex];
  const body = createTextMessageBody(content);
  versions[currentVersionIndex] = {
    ...currentVersion,
    content,
    body,
    attachments: undefined,
    savedAt: currentVersion.content.trim().length === 0 ? savedAt : currentVersion.savedAt,
    ...(versionExtras?.reasoningContent !== undefined ? { reasoningContent: versionExtras.reasoningContent } : {}),
    ...(versionExtras?.thinkingDurationMs !== undefined ? { thinkingDurationMs: versionExtras.thinkingDurationMs } : {}),
    ...(versionExtras?.totalDurationMs !== undefined ? { totalDurationMs: versionExtras.totalDurationMs } : {}),
    ...(versionExtras?.tokenStats !== undefined ? { tokenStats: versionExtras.tokenStats } : {}),
    ...(versionExtras?.model !== undefined ? { model: versionExtras.model } : {}),
    ...(versionExtras?.providerId !== undefined ? { providerId: versionExtras.providerId } : {}),
    ...(versionExtras?.optionId !== undefined ? { optionId: versionExtras.optionId } : {}),
    ...(versionExtras?.assistantLabel !== undefined ? { assistantLabel: versionExtras.assistantLabel } : {})
  };

  return {
    ...message,
    content,
    body,
    attachments: undefined,
    currentVersionId,
    versions
  };
}

function setMessageCurrentStructuredContent(
  message: ChatMessage,
  body: ChatMessageBody,
  attachments: ChatAttachment[],
  content: string,
  savedAt: string = new Date().toISOString(),
  versionExtras?: {
    reasoningContent?: string;
    thinkingDurationMs?: number;
    totalDurationMs?: number;
    tokenStats?: ChatTokenStats;
    model?: string;
    providerId?: string;
    optionId?: string;
    assistantLabel?: string;
  }
): ChatMessage {
  const versions = [...(message.versions ?? [])];
  const currentVersionId = normalizeCurrentVersionId(message.currentVersionId, versions);
  const currentVersionIndex = currentVersionId ? versions.findIndex((version) => version.id === currentVersionId) : -1;
  const normalizedBody = createChatMessageBody(body.parts);
  const persistedAttachments = attachments.length > 0 ? attachments : undefined;

  if (currentVersionIndex < 0) {
    const nextVersion = createMessageVersion(content, savedAt, versionExtras, normalizedBody, persistedAttachments);
    return {
      ...message,
      content,
      body: normalizedBody,
      attachments: persistedAttachments,
      currentVersionId: nextVersion.id,
      versions: [...versions, nextVersion]
    };
  }

  const currentVersion = versions[currentVersionIndex];
  versions[currentVersionIndex] = {
    ...currentVersion,
    content,
    body: normalizedBody,
    attachments: persistedAttachments,
    savedAt: currentVersion.content.trim().length === 0 ? savedAt : currentVersion.savedAt,
    ...(versionExtras?.reasoningContent !== undefined ? { reasoningContent: versionExtras.reasoningContent } : {}),
    ...(versionExtras?.thinkingDurationMs !== undefined ? { thinkingDurationMs: versionExtras.thinkingDurationMs } : {}),
    ...(versionExtras?.totalDurationMs !== undefined ? { totalDurationMs: versionExtras.totalDurationMs } : {}),
    ...(versionExtras?.tokenStats !== undefined ? { tokenStats: versionExtras.tokenStats } : {}),
    ...(versionExtras?.model !== undefined ? { model: versionExtras.model } : {}),
    ...(versionExtras?.providerId !== undefined ? { providerId: versionExtras.providerId } : {}),
    ...(versionExtras?.optionId !== undefined ? { optionId: versionExtras.optionId } : {}),
    ...(versionExtras?.assistantLabel !== undefined ? { assistantLabel: versionExtras.assistantLabel } : {})
  };

  return {
    ...message,
    content,
    body: normalizedBody,
    attachments: persistedAttachments,
    currentVersionId,
    versions
  };
}

function createTextMessageBody(content: string): ChatMessageBody {
  return createChatMessageBody(content ? [{ type: 'text', text: content }] : []);
}

function getBodyPlainText(body: ChatMessageBody, attachments: ChatAttachment[] = []): string {
  const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  return body.parts
    .map((part) => {
      if (part.type === 'text') {
        return part.text;
      }

      const attachment = attachmentById.get(part.attachmentId);
      if (!attachment) {
        return t('host.attachmentBracket');
      }

      return attachment.kind === 'image'
        ? t('host.attachmentImageBracket', { name: attachment.originalName })
        : t('host.attachmentFileBracket', { name: attachment.originalName });
    })
    .join('');
}

function createClipboardMarkdownForMessage(
  message: Pick<ChatMessage, 'body' | 'attachments' | 'versions' | 'currentVersionId'>
): string {
  return createClipboardMarkdownForBody(getMessageCurrentBody(message), getMessageCurrentAttachments(message));
}

function createClipboardMarkdownForVersion(version: ChatMessageVersion): string {
  return createClipboardMarkdownForBody(version.body, version.attachments ?? []);
}

function createClipboardMarkdownForBody(body: ChatMessageBody, attachments: ChatAttachment[] = []): string {
  const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  return body.parts
    .map((part) => {
      if (part.type === 'text') {
        return part.text;
      }

      const attachment = attachmentById.get(part.attachmentId);
      if (!attachment) {
        return t('host.attachmentLost');
      }

      const label = sanitizeMarkdownLabel(attachment.originalName || path.posix.basename(attachment.assetPath));
      const destination = normalizeStoredAssetPath(attachment.assetPath);
      return attachment.kind === 'image'
        ? `![${label}](${destination})`
        : `[${label}](${destination})`;
    })
    .join('');
}

function sanitizeMarkdownLabel(value: string): string {
  return value.replace(/[\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim() || 'attachment';
}

function unescapeMarkdownLabel(value: string): string {
  return value.replace(/\\([\\\[\]])/g, '$1').replace(/\s+/g, ' ').trim();
}

function createPersistedMessageVersion(
  message: Pick<
    ChatMessage,
    | 'id'
    | 'content'
    | 'body'
    | 'attachments'
    | 'createdAt'
    | 'currentVersionId'
    | 'versions'
    | 'reasoningContent'
    | 'thinkingDurationMs'
    | 'totalDurationMs'
    | 'tokenStats'
    | 'model'
    | 'providerId'
    | 'optionId'
  >
): ChatMessageVersion {
  const persistedId = typeof message.currentVersionId === 'string' && message.currentVersionId.trim()
    ? message.currentVersionId
    : `${message.id}-v1`;

  return {
    id: persistedId,
    content: getMessageCurrentContent(message),
    body: getMessageCurrentBody(message),
    ...(getMessageCurrentAttachments(message).length > 0 ? { attachments: getMessageCurrentAttachments(message) } : {}),
    savedAt: message.createdAt,
    ...(message.reasoningContent !== undefined ? { reasoningContent: message.reasoningContent } : {}),
    ...(message.thinkingDurationMs !== undefined ? { thinkingDurationMs: message.thinkingDurationMs } : {}),
    ...(message.totalDurationMs !== undefined ? { totalDurationMs: message.totalDurationMs } : {}),
    ...(message.tokenStats !== undefined ? { tokenStats: message.tokenStats } : {}),
    ...(message.model !== undefined ? { model: message.model } : {}),
    ...(message.providerId !== undefined ? { providerId: message.providerId } : {}),
    ...(message.optionId !== undefined ? { optionId: message.optionId } : {}),
    ...(getMessageCurrentAssistantLabel(message) !== undefined ? { assistantLabel: getMessageCurrentAssistantLabel(message) } : {})
  };
}

function persistMessageVersion(version: ChatMessageVersion): PersistedChatMessageVersion {
  const normalizedVersion: ChatMessageVersion = {
    ...version,
    body: createChatMessageBody(version.body.parts)
  };

  if (canPersistVersionAsPlainContent(normalizedVersion)) {
    const { body: _body, attachments: _attachments, ...persistedVersion } = normalizedVersion;
    return persistedVersion;
  }

  const { content: _content, ...persistedVersion } = normalizedVersion;
  return persistedVersion;
}

function canPersistVersionAsPlainContent(
  version: Pick<ChatMessageVersion, 'content' | 'body' | 'attachments'>
): boolean {
  if ((version.attachments?.length ?? 0) > 0) {
    return false;
  }

  const textOnlyContent = getTextOnlyBodyContent(version.body);
  return textOnlyContent !== undefined && textOnlyContent === version.content;
}

function getTextOnlyBodyContent(body: ChatMessageBody): string | undefined {
  let content = '';
  for (const part of body.parts) {
    if (part.type !== 'text') {
      return undefined;
    }

    content += part.text;
  }

  return content;
}

function getPersistedMessageVersions(message: ChatMessage): PersistedChatMessageVersion[] {
  const versions = message.versions ?? [];
  if (versions.length > 0) {
    return versions.map((version) => persistMessageVersion(version));
  }

  return [persistMessageVersion(createPersistedMessageVersion(message))];
}

function createPersistedChatMessage(message: ChatMessage): PersistedChatMessage {
  const versions = getPersistedMessageVersions(message);
  const currentVersionId = versions.length > 1
    ? normalizeCurrentVersionId(message.currentVersionId, versions)
    : undefined;

  const {
    content: _content,
    body: _body,
    attachments: _attachments,
    childIds: _childIds,
    currentVersionId: _runtimeCvId,
    reasoningContent: _reasoningContent,
    thinkingDurationMs: _thinkingDurationMs,
    totalDurationMs: _totalDurationMs,
    tokenStats: _tokenStats,
    model: _model,
    providerId: _providerId,
    optionId: _optionId,
    status,
    errorDetail,
    ...persistedMessage
  } = message;

  return {
    ...persistedMessage,
    ...(currentVersionId ? { currentVersionId } : {}),
    ...(status && status !== 'completed' ? { status } : {}),
    ...(status === 'error' && errorDetail ? { errorDetail } : {}),
    versions
  };
}

function createPersistedChatFile(chat: ChatFile): PersistedChatFile {
  const { messages, modelSelection, ...rest } = chat;

  return {
    ...rest,
    ...(modelSelection ? { modelSelection: chatModelSelectionToJSON(modelSelection) } : {}),
    messages: messages.map((message) => createPersistedChatMessage(message))
  };
}

function chatModelSelectionToJSON(selection: ChatModelSelection): PersistedChatModelSelectionJSON {
  return {
    model: selection.modelId,
    providerId: selection.providerId,
    optionId: selection.optionId
  };
}

function serializeChatFile(chat: ChatFile): string {
  return `${JSON.stringify(createPersistedChatFile(chat), null, 2)}\n`;
}

function createMessage(
  role: ChatRole,
  content: string,
  options: {
    createdAt?: string;
    createInitialVersion?: boolean;
    id?: string;
    model?: string;
    providerId?: string;
    optionId?: string;
    assistantLabel?: string;
    reasoningContent?: string;
    thinkingDurationMs?: number;
    totalDurationMs?: number;
    tokenStats?: ChatTokenStats;
    versionSavedAt?: string;
    status?: ChatMessageStatus;
    body?: ChatMessageBody;
    attachments?: ChatAttachment[];
  } = {}
): ChatMessage {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const body = options.body ? createChatMessageBody(options.body.parts) : createTextMessageBody(content);
  const attachments = options.attachments?.length ? options.attachments : undefined;
  const initialVersion = options.createInitialVersion === false
    ? undefined
    : createMessageVersion(content, options.versionSavedAt ?? createdAt, {
        reasoningContent: options.reasoningContent,
        thinkingDurationMs: options.thinkingDurationMs,
        totalDurationMs: options.totalDurationMs,
        tokenStats: options.tokenStats,
        model: options.model,
        providerId: options.providerId,
        optionId: options.optionId,
        assistantLabel: options.assistantLabel
      }, body, attachments);

  return {
    id: options.id ?? crypto.randomUUID(),
    role,
    content,
    body,
    attachments,
    currentVersionId: initialVersion?.id,
    createdAt,
    model: options.model,
    providerId: options.providerId,
    optionId: options.optionId,
    reasoningContent: options.reasoningContent,
    thinkingDurationMs: options.thinkingDurationMs,
    totalDurationMs: options.totalDurationMs,
    tokenStats: options.tokenStats,
    status: options.status,
    versions: initialVersion ? [initialVersion] : undefined
  };
}

async function replaceDocumentContent(document: vscode.TextDocument, nextContent: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  edit.replace(document.uri, fullRange, nextContent);

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error(t('host.cannotWriteChatFile'));
  }

  if (document.isUntitled) {
    return;
  }

  const saved = await document.save();
  if (!saved) {
    throw new Error(t('host.chatFileUpdatedSaveFailed'));
  }
}

async function loadKeyConfig(document: vscode.TextDocument): Promise<KeyFileConfig> {
  return loadKeyConfigForResource(document.uri);
}

async function loadKeyConfigForResource(resourceUri?: vscode.Uri): Promise<KeyFileConfig> {
  const resolution = await resolveChatDataDirectoryResolution(resourceUri);
  const candidateKeyUris = getChatDataFileCandidateUris(resolution, 'key.json');
  const keyUri = await findFirstExistingUri(candidateKeyUris);
  let fileContent: Uint8Array;

  if (!keyUri) {
    throw new Error(t('host.keyFileNotFound', { paths: candidateKeyUris.map((uri) => uri.fsPath).join('; ') }));
  }

  fileContent = await vscode.workspace.fs.readFile(keyUri);

  const raw = parseJsoncDocument(decodeUtf8(fileContent), `key.json：${keyUri.fsPath}`);

  if (!isObject(raw)) {
    throw new Error(t('host.keyJsonRootMustBeObject'));
  }

  assertNoUnsupportedKeyFileFields(raw);

  if (!isObject(raw.providers)) {
    throw new Error(t('host.keyJsonMustHaveProviders'));
  }

  const providers = Object.fromEntries(
    Object.entries(raw.providers).map(([providerId, providerRaw]) => [providerId, normalizeKeyFileProviderConfig(providerId, providerRaw)])
  );

  if (Object.keys(providers).length === 0) {
    throw new Error(t('host.keyJsonProvidersEmpty'));
  }

  return {
    providers,
    titleGeneration: normalizeOptionalKeyFileTitleGenerationConfig(raw.titleGeneration)
  };
}

async function loadCommonConfigs(document: vscode.TextDocument): Promise<CommonConfigsFile> {
  const resolution = await resolveChatDataDirectoryResolution(document.uri);
  const configUri = await findFirstExistingUri(getChatDataFileCandidateUris(resolution, CHAT_COMMON_CONFIGS_FILE_NAME));
  let fileContent: Uint8Array;

  if (!configUri) {
    return {};
  }

  fileContent = await vscode.workspace.fs.readFile(configUri);

  const raw = parseJsoncDocument(decodeUtf8(fileContent), `common_configs.json：${configUri.fsPath}`);

  if (!isObject(raw)) {
    throw new Error(t('host.commonConfigsRootMustBeObject'));
  }

  const configs: CommonConfigsFile = {};
  for (const [configId, entryRaw] of Object.entries(raw)) {
    if (!isObject(entryRaw)) {
      continue;
    }

    const name = typeof entryRaw.name === 'string' && entryRaw.name.trim() ? entryRaw.name.trim() : undefined;
    const systemPrompt = typeof entryRaw.system_prompt === 'string' && entryRaw.system_prompt.trim() ? entryRaw.system_prompt.trim() : '';
    const messageTemplate = typeof entryRaw.message_template === 'string' && entryRaw.message_template.trim() ? entryRaw.message_template.trim() : '';

    if (!name) {
      continue;
    }

    configs[configId] = {
      name,
      system_prompt: systemPrompt,
      message_template: messageTemplate
    };
  }

  return configs;
}

function resolveEffectiveSystemPrompt(chat: ChatFile, commonConfigs: CommonConfigsFile): string | null {
  const field = chat.systemPrompt;
  if (!field) {
    return null;
  }

  if (field.inherit && chat.commonConfigId) {
    const entry = commonConfigs[chat.commonConfigId];
    if (entry && entry.system_prompt) {
      return entry.system_prompt;
    }

    return null;
  }

  return field.content || null;
}

function resolveEffectiveMessageTemplate(chat: ChatFile, commonConfigs: CommonConfigsFile): string | null {
  const field = chat.messageTemplate;
  if (!field) {
    return null;
  }

  if (field.inherit && chat.commonConfigId) {
    const entry = commonConfigs[chat.commonConfigId];
    if (entry && entry.message_template) {
      return entry.message_template;
    }

    return null;
  }

  return field.content || null;
}

function createWebviewCommonConfigState(chat: ChatFile, commonConfigs: CommonConfigsFile): WebviewCommonConfigState {
  const selectedId = chat.commonConfigId ?? undefined;
  const selectedEntry = selectedId ? commonConfigs[selectedId] : undefined;
  const options = Object.entries(commonConfigs)
    .sort(([, left], [, right]) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' }))
    .map(([id, entry]) => ({
      id,
      name: entry.name,
      systemPrompt: entry.system_prompt,
      messageTemplate: entry.message_template
    }));

  return {
    selectedId,
    selectedName: selectedEntry?.name,
    hasMissingSelection: Boolean(selectedId && !selectedEntry),
    options
  };
}

function createWebviewConfigFieldState(
  chat: ChatFile,
  commonConfigs: CommonConfigsFile,
  fieldKey: keyof Pick<CommonConfigEntry, 'system_prompt' | 'message_template'>
): WebviewConfigFieldState {
  const field = fieldKey === 'system_prompt' ? chat.systemPrompt : chat.messageTemplate;
  const inheritedConfigId = chat.commonConfigId ?? undefined;
  const inheritedEntry = inheritedConfigId ? commonConfigs[inheritedConfigId] : undefined;
  const inheritedValue = inheritedEntry?.[fieldKey] ?? '';
  const inherit = field?.inherit === true;
  const content = field?.content ?? '';
  const effectiveContent = inherit ? inheritedValue : content;

  let source: WebviewConfigFieldSource = 'none';
  if (inherit && inheritedValue) {
    source = 'common-config';
  } else if (!inherit && content) {
    source = 'local';
  }

  return {
    inherit,
    content,
    effectiveContent,
    source,
    inheritedConfigId,
    inheritedConfigName: inheritedEntry?.name,
    missingInheritedConfig: Boolean(inherit && inheritedConfigId && !inheritedEntry),
    missingInheritedValue: Boolean(inherit && inheritedEntry && !inheritedValue),
    hasRetainedDraft: Boolean(inherit && content)
  };
}

function createInheritableTextFieldForSave(inherit: boolean, content: unknown): InheritableTextField {
  return {
    inherit,
    content: normalizeOptionalStringOrNull(content) ?? null
  };
}

function normalizeKeyFileProviderConfig(providerId: string, raw: unknown): KeyFileProviderConfig {
  const normalizedProviderId = normalizeRequiredKeyFileString(providerId, t('host.providersKeyLabel'));
  if (!isObject(raw)) {
    throw new Error(t('host.providerConfigMustBeObject', { id: normalizedProviderId }));
  }

  const label = normalizeRequiredKeyFileString(raw.label, `provider ${normalizedProviderId}.label`);
  const transport = normalizeRequiredKeyFileString(raw.transport, `provider ${normalizedProviderId}.transport`);
  if (transport !== 'openai-compatible') {
    throw new Error(t('host.providerTransportOnly', { id: normalizedProviderId }));
  }

  const apiKey = normalizeRequiredKeyFileEnvString(raw.api_key, `provider ${normalizedProviderId}.api_key`);
  const apiBase = normalizeOptionalKeyFileEnvString(raw.api_base, `provider ${normalizedProviderId}.api_base`);
  const models = normalizeKeyFileModels(normalizedProviderId, raw.models);

  if (models.length === 0) {
    throw new Error(t('host.providerModelsRequired', { id: normalizedProviderId }));
  }

  return {
    label,
    transport,
    api_key: apiKey,
    api_base: apiBase,
    models
  };
}

function normalizeKeyFileModels(providerId: string, raw: unknown): KeyFileModelConfig[] {
  if (!Array.isArray(raw)) {
    throw new Error(t('host.providerModelsMustBeArray', { id: providerId }));
  }

  const models = raw.map((modelRaw, index) => normalizeKeyFileModelConfig(providerId, index, modelRaw));
  const seenModelIds = new Set<string>();
  for (const model of models) {
    if (seenModelIds.has(model.id)) {
      throw new Error(t('host.providerModelDuplicateId', { id: providerId, modelId: model.id }));
    }

    seenModelIds.add(model.id);
  }

  return models;
}

function normalizeKeyFileModelConfig(providerId: string, index: number, raw: unknown): KeyFileModelConfig {
  if (!isObject(raw)) {
    throw new Error(t('host.providerModelMustBeObject', { id: providerId, index }));
  }

  const id = normalizeRequiredKeyFileString(raw.id, `provider ${providerId}.models[${index}].id`);
  const label = normalizeRequiredKeyFileString(raw.label, `provider ${providerId}.models[${index}].label`);
  const options = normalizeKeyFileOptions(providerId, id, raw.options);

  return {
    id,
    label,
    options: options.length > 0 ? options : undefined
  };
}

function normalizeKeyFileOptions(providerId: string, modelId: string, raw: unknown): KeyFileOptionConfig[] {
  if (raw === undefined) {
    return [];
  }

  if (!Array.isArray(raw)) {
    throw new Error(t('host.providerOptionsMustBeArray', { id: providerId, modelId }));
  }

  const options = raw.map((optionRaw, index) => normalizeKeyFileOptionConfig(providerId, modelId, index, optionRaw));
  const seenOptionIds = new Set<string>();
  for (const option of options) {
    if (seenOptionIds.has(option.id)) {
      throw new Error(t('host.providerOptionDuplicateId', { id: providerId, modelId, optionId: option.id }));
    }

    seenOptionIds.add(option.id);
  }

  return options;
}

function normalizeKeyFileOptionConfig(providerId: string, modelId: string, index: number, raw: unknown): KeyFileOptionConfig {
  if (!isObject(raw)) {
    throw new Error(t('host.providerOptionMustBeObject', { id: providerId, modelId, index }));
  }

  const id = normalizeRequiredKeyFileString(raw.id, `provider ${providerId}.models(${modelId}).options[${index}].id`);
  const label = normalizeRequiredKeyFileString(raw.label, `provider ${providerId}.models(${modelId}).options[${index}].label`);
  const config = normalizeOptionalKeyFileObject(raw.config, `provider ${providerId}.models(${modelId}).options[${index}].config`);

  return {
    id,
    label,
    config
  };
}

function normalizeOptionalKeyFileTitleGenerationConfig(raw: unknown): KeyFileTitleGenerationConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (!isObject(raw)) {
    return {
      selectionError: t('host.titleGenerationMustBeObject')
    };
  }

  if (raw.selection === undefined) {
    return {};
  }

  try {
    return {
      selection: normalizeRequiredTitleGenerationSelection(raw.selection)
    };
  } catch (error) {
    return {
      selectionError: t('host.titleGenerationSelectionInvalid', { detail: toErrorMessage(error) })
    };
  }
}

function normalizeRequiredTitleGenerationSelection(raw: unknown): ChatModelSelection {
  const selection = normalizeModelSelectionField(raw);
  if (!selection?.providerId || !selection.modelId) {
    throw new Error(t('host.providerIdAndModelIdRequired'));
  }

  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    optionId: selection.optionId
  };
}

function normalizeRequiredKeyFileString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(t('host.fieldMustBeNonEmptyString', { field: fieldName }));
  }

  return value.trim();
}

function normalizeOptionalKeyFileString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(t('host.fieldMustBeNonEmptyString', { field: fieldName }));
  }

  return value.trim();
}

function normalizeRequiredKeyFileEnvString(value: unknown, fieldName: string): string {
  const normalized = normalizeRequiredKeyFileString(value, fieldName);
  return normalizeRequiredKeyFileString(resolveKeyFileEnvironmentVariables(normalized, fieldName), fieldName);
}

function normalizeOptionalKeyFileEnvString(value: unknown, fieldName: string): string | undefined {
  const normalized = normalizeOptionalKeyFileString(value, fieldName);
  if (normalized === undefined) {
    return undefined;
  }

  return normalizeRequiredKeyFileString(resolveKeyFileEnvironmentVariables(normalized, fieldName), fieldName);
}

function resolveKeyFileEnvironmentVariables(value: string, fieldName: string): string {
  return value.replace(KEY_FILE_ENV_VAR_REGEX, (_match, envName: string) => {
    const envValue = process.env[envName];
    if (typeof envValue !== 'string' || !envValue.trim()) {
      throw new Error(t('host.envVarNotSet', { field: fieldName, envName }));
    }

    return envValue;
  });
}

function normalizeOptionalKeyFileObject(value: unknown, fieldName: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isObject(value)) {
    throw new Error(t('host.fieldMustBeObject', { field: fieldName }));
  }

  return { ...value };
}

function normalizeOptionalStringOrNull(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  return undefined;
}

function normalizeInheritableTextField(value: unknown): InheritableTextField | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  if (typeof value.inherit !== 'boolean') {
    return undefined;
  }

  const content = value.content === null
    ? null
    : typeof value.content === 'string' && value.content.trim()
      ? value.content.trim()
      : null;

  return {
    inherit: value.inherit,
    content
  };
}

function normalizeModelSelectionField(raw: unknown): ChatModelSelection | undefined {
  if (!isObject(raw)) {
    return undefined;
  }

  const model = typeof raw.model === 'string' && raw.model.trim()
    ? raw.model.trim()
    : typeof raw.modelId === 'string' && raw.modelId.trim()
      ? raw.modelId.trim()
      : undefined;

  const providerId = typeof raw.providerId === 'string' && raw.providerId.trim()
    ? raw.providerId.trim()
    : typeof raw.provider === 'string' && raw.provider.trim()
      ? raw.provider.trim()
      : undefined;

  const optionId = typeof raw.optionId === 'string' && raw.optionId.trim()
    ? raw.optionId.trim()
    : typeof raw.option === 'string' && raw.option.trim()
      ? raw.option.trim()
      : undefined;

  if (!model && !providerId && !optionId) {
    return undefined;
  }

  return {
    modelId: model,
    providerId,
    optionId
  };
}

function getKeyFileUriForDirectory(directoryUri: vscode.Uri): vscode.Uri {
  return getChatDataFileUriForBaseDirectory(directoryUri, 'key.json');
}

function getCommonConfigsFileUriForDirectory(directoryUri: vscode.Uri): vscode.Uri {
  return getChatDataFileUriForBaseDirectory(directoryUri, CHAT_COMMON_CONFIGS_FILE_NAME);
}

function getChatDataDirectoryUriForBaseDirectory(baseDirectoryUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(baseDirectoryUri, CHAT_DIRECTORY_NAME);
}

function getChatDataFileUriForBaseDirectory(baseDirectoryUri: vscode.Uri, relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(getChatDataDirectoryUriForBaseDirectory(baseDirectoryUri), relativePath);
}

function getChatDataFileCandidateUris(
  resolution: ChatDataDirectoryResolution,
  relativePath: string
): vscode.Uri[] {
  return resolution.candidateBaseDirectories.map((baseDirectoryUri) => getChatDataFileUriForBaseDirectory(baseDirectoryUri, relativePath));
}

async function findFirstExistingUri(candidateUris: readonly vscode.Uri[]): Promise<vscode.Uri | undefined> {
  for (const candidateUri of candidateUris) {
    if (await uriExists(candidateUri)) {
      return candidateUri;
    }
  }

  return undefined;
}

function findContainingChatDataBasePath(resourcePath: string): string | undefined {
  let currentPath = path.resolve(resourcePath);

  while (true) {
    if (path.basename(currentPath).toLowerCase() === CHAT_DIRECTORY_NAME) {
      return path.dirname(currentPath);
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return undefined;
    }

    currentPath = parentPath;
  }
}

async function getNextBranchFileUri(sourceUri: vscode.Uri): Promise<vscode.Uri> {
  const directoryUri = vscode.Uri.file(path.dirname(sourceUri.fsPath));
  const baseName = trimChatFileSuffix(path.basename(sourceUri.fsPath));

  for (let index = 1; index < 1000; index += 1) {
    const branchUri = vscode.Uri.joinPath(directoryUri, `${baseName}.branch-${index}${CHAT_FILE_EXTENSION}`);

    try {
      await vscode.workspace.fs.stat(branchUri);
    } catch {
      return branchUri;
    }
  }

  throw new Error(t('host.tooManyBranchFiles'));
}

async function requestCompletionStreaming(
  document: vscode.TextDocument,
  config: ResolvedModelConfig,
  messages: ChatMessage[],
  onChunk: (contentDelta: string, reasoningDelta: string, content: string, reasoningContent: string) => void,
  abortSignal: AbortSignal,
  chat: ChatFile,
  commonConfigs: CommonConfigsFile
): Promise<AssistantResponse> {
  const requestStartedAt = Date.now();
  return streamDirectOpenAI(document, config, messages, onChunk, requestStartedAt, abortSignal, chat, commonConfigs);
}

async function requestGeneratedChatTitle(config: ResolvedModelConfig, prompt: string): Promise<string> {
  const client = new OpenAI({
    apiKey: config.api_key,
    baseURL: config.api_base ?? 'https://api.openai.com/v1'
  });
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, TITLE_GENERATION_REQUEST_TIMEOUT_MS);

  try {
    const response = await client.chat.completions.create({
      ...config.extraRequestConfig,
      model: config.model,
      messages: [
        {
          role: 'system',
          content: TITLE_GENERATION_SYSTEM_PROMPT()
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    } as any, {
      signal: abortController.signal
    });
    const content = extractChatCompletionText(response);
    if (!content.trim()) {
      throw new Error(t('host.modelReturnedEmpty'));
    }

    return content;
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error(t('host.titleGenerationTimeout'));
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractChatCompletionText(response: unknown): string {
  if (typeof response === 'string') {
    return extractChatCompletionTextFromRawString(response);
  }

  if (!isObject(response)) {
    return '';
  }

  return extractChatCompletionTextFromObject(response);
}

function extractChatCompletionTextFromObject(response: Record<string, unknown>): string {
  const firstChoice = Array.isArray(response.choices) ? response.choices[0] : undefined;
  const choiceMessage = isObject(firstChoice) && isObject(firstChoice.message)
    ? firstChoice.message
    : undefined;
  const choiceDelta = isObject(firstChoice) && isObject(firstChoice.delta)
    ? firstChoice.delta
    : undefined;
  const choiceContent = isObject(firstChoice)
    ? firstChoice.content ?? firstChoice.text ?? firstChoice.output_text ?? firstChoice.message
    : undefined;

  return extractStructuredText(
    choiceDelta?.content ??
      choiceDelta?.text ??
      choiceDelta?.output_text ??
      choiceDelta?.delta ??
      choiceMessage?.content ??
      choiceMessage?.text ??
      choiceMessage?.output_text ??
      choiceContent ??
      response.content ??
      response.text ??
      response.output_text ??
      response.message
  );
}

function extractChatCompletionTextFromRawString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const ssePayloads = extractSseDataPayloads(trimmed);
  if (ssePayloads.length > 0) {
    const content = ssePayloads
      .map((payload) => extractTextFromPossibleJson(payload))
      .join('');
    if (content.trim()) {
      return content;
    }
  }

  return extractTextFromPossibleJson(trimmed);
}

function extractSseDataPayloads(value: string): string[] {
  const payloads: string[] = [];

  for (const line of value.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith('data:')) {
      continue;
    }

    const payload = trimmedLine.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') {
      continue;
    }

    payloads.push(payload);
  }

  return payloads;
}

function extractTextFromPossibleJson(value: string): string {
  const parsed = tryParseJsonString(value);
  if (parsed !== undefined) {
    return extractChatCompletionText(parsed);
  }

  return value;
}

function tryParseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"'))) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

async function streamDirectOpenAI(
  document: vscode.TextDocument,
  config: ResolvedModelConfig,
  messages: ChatMessage[],
  onChunk: (contentDelta: string, reasoningDelta: string, content: string, reasoningContent: string) => void,
  requestStartedAt: number,
  abortSignal: AbortSignal,
  chat: ChatFile,
  commonConfigs: CommonConfigsFile
): Promise<AssistantResponse> {
  const client = new OpenAI({
    apiKey: config.api_key,
    baseURL: config.api_base ?? 'https://api.openai.com/v1'
  });

  const modelMessages = await createModelRequestMessages(document, messages, chat, config, commonConfigs);

  const params: Record<string, unknown> = {
    ...config.extraRequestConfig,
    model: config.model,
    messages: modelMessages,
    stream: true,
    stream_options: createStreamOptionsWithUsage(config.extraRequestConfig.stream_options)
  };

  let content = '';
  let reasoning = '';
  let tokenStats: ChatTokenStats | undefined;
  let reasoningStartAt: number | undefined;
  let reasoningFinishedAt: number | undefined;

  try {
    const stream = await createChatCompletionStream(client, params, abortSignal);

    for await (const chunk of stream) {
      if (abortSignal.aborted) {
        throw new RequestCanceledError(content, reasoning);
      }

      tokenStats = normalizeUsageTokenStats(chunk) ?? tokenStats;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) {
        continue;
      }

      const contentDelta = extractTextDelta(delta);
      const reasoningDelta = extractReasoningDelta(delta);

      if (reasoningDelta) {
        if (reasoningStartAt === undefined) {
          reasoningStartAt = Date.now();
        }
        reasoningFinishedAt = Date.now();
      }

      if (contentDelta || reasoningDelta) {
        content += contentDelta;
        reasoning += reasoningDelta;
        onChunk(contentDelta, reasoningDelta, content, reasoning);
      }
    }
  } catch (error) {
    if (abortSignal.aborted) {
      throw new RequestCanceledError(content, reasoning);
    }

    throw error;
  }

  if (!content) {
    throw new Error(t('host.modelReturnedEmpty'));
  }

  const totalDurationMs = Date.now() - requestStartedAt;
  const thinkingDurationMs = reasoningStartAt !== undefined
    ? (reasoningFinishedAt ?? Date.now()) - reasoningStartAt
    : 0;

  return {
    content,
    reasoningContent: reasoning || undefined,
    thinkingDurationMs,
    totalDurationMs,
    tokenStats
  };
}

interface StreamingChunk {
  model?: string;
  usage?: unknown;
  choices?: Array<{ delta?: Record<string, unknown> }>;
}

class RequestCanceledError extends Error {
  partialContent: string;
  partialReasoning: string;

  constructor(partialContent: string, partialReasoning: string) {
    super('request canceled');
    this.name = 'RequestCanceledError';
    this.partialContent = partialContent;
    this.partialReasoning = partialReasoning;
  }
}

function isRequestCanceledError(error: unknown): error is RequestCanceledError {
  return error instanceof RequestCanceledError;
}

async function createChatCompletionStream(
  client: OpenAI,
  params: Record<string, unknown>,
  abortSignal: AbortSignal
): Promise<AsyncIterable<StreamingChunk>> {
  try {
    return await client.chat.completions.create(params as any, { signal: abortSignal }) as unknown as AsyncIterable<StreamingChunk>;
  } catch (error) {
    if (!isUnsupportedRequestParameterError(error, ['stream_options', 'include_usage'])) {
      throw error;
    }

    const retryParams = { ...params };
    delete retryParams.stream_options;

    return await client.chat.completions.create(retryParams as any, { signal: abortSignal }) as unknown as AsyncIterable<StreamingChunk>;
  }
}

function extractTextDelta(delta: Record<string, unknown>): string {
  const messageContent = isObject(delta.message) ? delta.message.content : undefined;
  return extractStructuredText(delta.content ?? delta.text ?? messageContent ?? delta.output_text);
}

function extractReasoningDelta(delta: Record<string, unknown>): string {
  return extractStructuredText(
    delta.reasoning_content ??
      delta.reasoning ??
      delta.reasoningContent ??
      delta.thinking ??
      delta.thinking_content ??
      delta.thinkingContent
  );
}

function extractStructuredText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.map((item) => extractStructuredText(item)).join('');
  }

  if (!isObject(value)) {
    return '';
  }

  const imageMarkdown = extractStructuredImageMarkdown(value);
  if (imageMarkdown) {
    return imageMarkdown;
  }

  if (typeof value.text === 'string') {
    return value.text;
  }

  if (typeof value.content === 'string') {
    return value.content;
  }

  if (Array.isArray(value.content)) {
    return extractStructuredText(value.content);
  }

  if (typeof value.delta === 'string') {
    return value.delta;
  }

  if (Array.isArray(value.delta)) {
    return extractStructuredText(value.delta);
  }

  if (Array.isArray(value.parts)) {
    return extractStructuredText(value.parts);
  }

  if (typeof value.output_text === 'string') {
    return value.output_text;
  }

  if (Array.isArray(value.output_text)) {
    return extractStructuredText(value.output_text);
  }

  if (typeof value.reasoning === 'string') {
    return value.reasoning;
  }

  if (Array.isArray(value.reasoning)) {
    return extractStructuredText(value.reasoning);
  }

  if (typeof value.reasoning_content === 'string') {
    return value.reasoning_content;
  }

  if (Array.isArray(value.reasoning_content)) {
    return extractStructuredText(value.reasoning_content);
  }

  if (typeof value.thinking === 'string') {
    return value.thinking;
  }

  if (Array.isArray(value.thinking)) {
    return extractStructuredText(value.thinking);
  }

  return '';
}

function extractStructuredImageMarkdown(value: Record<string, unknown>): string {
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : '';
  const url = extractStructuredImageUrl(value);
  if (!url) {
    return '';
  }

  if (type.includes('image') || value.image_url !== undefined || value.b64_json !== undefined) {
    const label = typeof value.alt === 'string' && value.alt.trim()
      ? value.alt.trim()
      : typeof value.name === 'string' && value.name.trim()
        ? value.name.trim()
        : 'assistant-image';
    return `![${sanitizeMarkdownLabel(label)}](${url})`;
  }

  return '';
}

function extractStructuredImageUrl(value: Record<string, unknown>): string | undefined {
  if (typeof value.url === 'string' && value.url.trim()) {
    return value.url.trim();
  }

  if (typeof value.image_url === 'string' && value.image_url.trim()) {
    return value.image_url.trim();
  }

  if (isObject(value.image_url) && typeof value.image_url.url === 'string' && value.image_url.url.trim()) {
    return value.image_url.url.trim();
  }

  if (typeof value.b64_json === 'string' && value.b64_json.trim()) {
    return `data:image/png;base64,${value.b64_json.trim()}`;
  }

  if (isObject(value.source)) {
    const mediaType = normalizeMimeType(typeof value.source.media_type === 'string' ? value.source.media_type : undefined);
    if (typeof value.source.data === 'string' && value.source.data.trim() && mediaType.startsWith('image/')) {
      return `data:${mediaType};base64,${value.source.data.trim()}`;
    }
  }

  return undefined;
}

function normalizeMessageStatus(value: unknown): ChatMessageStatus | undefined {
  if (value === 'pending' || value === 'completed' || value === 'error' || value === 'canceled') {
    return value;
  }

  return undefined;
}

function normalizeDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

function normalizeTokenStats(raw: unknown): ChatTokenStats | undefined {
  if (!isObject(raw)) {
    return undefined;
  }

  const inputTokens = normalizeTokenCount(
    raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens
  );
  const outputTokens = normalizeTokenCount(
    raw.outputTokens ?? raw.output_tokens ?? raw.completionTokens ?? raw.completion_tokens
  );
  const cachedInputTokens = normalizeTokenCount(
    raw.cachedInputTokens ??
      raw.cached_input_tokens ??
      raw.cachedTokens ??
      raw.cached_tokens ??
      raw.promptCacheHitTokens ??
      raw.prompt_cache_hit_tokens ??
      raw.cacheReadInputTokens ??
      raw.cache_read_input_tokens ??
      raw.promptTokensDetails?.cachedTokens ??
      raw.promptTokensDetails?.cached_tokens ??
      raw.promptTokensDetails?.cacheRead ??
      raw.promptTokensDetails?.cache_read ??
      raw.prompt_tokens_details?.cachedTokens ??
      raw.prompt_tokens_details?.cached_tokens ??
      raw.prompt_tokens_details?.cacheRead ??
      raw.prompt_tokens_details?.cache_read ??
      raw.inputTokensDetails?.cachedTokens ??
      raw.inputTokensDetails?.cached_tokens ??
      raw.input_tokens_details?.cachedTokens ??
      raw.input_tokens_details?.cached_tokens ??
      raw.extra?.cachedTokens ??
      raw.extra?.cached_tokens
  );

  const totalTokens =
    normalizeTokenCount(raw.totalTokens ?? raw.total_tokens) ??
    (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);

  if (totalTokens === undefined) {
    return undefined;
  }

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cachedInputTokens
  };
}

function normalizeUsageTokenStats(raw: unknown): ChatTokenStats | undefined {
  const direct = normalizeTokenStats(raw);
  if (direct) {
    return direct;
  }

  if (!isObject(raw)) {
    return undefined;
  }

  for (const candidate of [raw.usage, raw.usageDetails, raw.usage_details, raw.tokenStats, raw.token_stats]) {
    const normalized = normalizeTokenStats(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function normalizeTokenCount(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.trunc(parsed);
    }

    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.trunc(value);
}

function createStreamOptionsWithUsage(raw: unknown): Record<string, unknown> {
  if (!isObject(raw)) {
    return { include_usage: true };
  }

  return {
    ...raw,
    include_usage: true
  };
}

function createWebviewProviderItems(config: KeyFileConfig): WebviewProviderItem[] {
  return Object.entries(config.providers).map(([providerId, provider]) => ({
    id: providerId,
    label: provider.label,
    models: provider.models.map((model) => ({
      id: model.id,
      label: model.label,
      options: (model.options ?? []).map((option) => ({
        id: option.id,
        label: option.label
      }))
    }))
  }));
}

function normalizeChatModelSelection(selection: ChatModelSelection | undefined, config: KeyFileConfig): ChatModelSelection | undefined {
  if (!selection?.providerId || !selection.modelId) {
    return undefined;
  }

  const provider = config.providers[selection.providerId];
  if (!provider) {
    return undefined;
  }

  const model = provider.models.find((item) => item.id === selection.modelId);
  if (!model) {
    return undefined;
  }

  const optionId = typeof selection.optionId === 'string' && selection.optionId.trim() ? selection.optionId.trim() : undefined;
  const options = model.options ?? [];

  if (options.length === 0) {
    return {
      providerId: selection.providerId,
      modelId: model.id,
      optionId: undefined
    };
  }

  if (!optionId) {
    return {
      providerId: selection.providerId,
      modelId: model.id,
      optionId: undefined
    };
  }

  if (optionId && options.some((item) => item.id === optionId)) {
    return {
      providerId: selection.providerId,
      modelId: model.id,
      optionId
    };
  }

  return undefined;
}

function findLastAssistantSelection(chat: ChatFile): ChatModelSelection | undefined {
  const activeMessages = getActiveConversationMessages(chat);

  for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
    const message = activeMessages[index];
    if (message.role !== 'assistant' || !message.providerId || !message.model) {
      continue;
    }

    return {
      providerId: message.providerId,
      modelId: message.model,
      optionId: message.optionId
    };
  }

  return undefined;
}

function resolveStoredChatModelSelection(chat: ChatFile, keyConfig: KeyFileConfig): ChatModelSelection | undefined {
  const persistedSelection = normalizeChatModelSelection(chat.modelSelection, keyConfig);
  if (persistedSelection) {
    return persistedSelection;
  }

  return normalizeChatModelSelection(findLastAssistantSelection(chat), keyConfig);
}

function resolveTitleGenerationRequestConfig(
  chat: ChatFile,
  keyConfig: KeyFileConfig,
  options: ResolveTitleGenerationRequestConfigOptions = {}
): ResolvedModelConfig {
  const titleGenerationConfig = keyConfig.titleGeneration;

  if (titleGenerationConfig?.selectionError) {
    if (!options.allowInvalidCustomSelectionFallback) {
      throw new Error(titleGenerationConfig.selectionError);
    }
  } else if (titleGenerationConfig?.selection) {
    try {
      return resolveModelConfig(keyConfig, titleGenerationConfig.selection);
    } catch (error) {
      if (!options.allowInvalidCustomSelectionFallback) {
        throw new Error(t('host.titleSelectionModelInvalid', { detail: toErrorMessage(error) }));
      }
    }
  }

  if (options.fallbackConfig) {
    return options.fallbackConfig;
  }

  const selection = resolveStoredChatModelSelection(chat, keyConfig);
  if (!selection) {
    throw new Error(t('host.noTitleModelAvailable'));
  }

  return resolveModelConfig(keyConfig, selection);
}

function resolveModelConfig(config: KeyFileConfig, selection: ChatModelSelection): ResolvedModelConfig {
  const normalizedSelection = normalizeChatModelSelection(selection, config);
  if (!normalizedSelection?.providerId || !normalizedSelection.modelId) {
    throw new Error(t('host.selectModelFirst'));
  }

  const provider = config.providers[normalizedSelection.providerId];
  const model = provider.models.find((item) => item.id === normalizedSelection.modelId);
  if (!model) {
    throw new Error(t('host.selectedModelNotFound'));
  }

  const option = normalizedSelection.optionId
    ? (model.options ?? []).find((item) => item.id === normalizedSelection.optionId)
    : undefined;

  const extraRequestConfig = { ...(option?.config ?? {}) };
  assertNoReservedRequestConfigKeys(extraRequestConfig);

  return {
    providerId: normalizedSelection.providerId,
    providerLabel: provider.label,
    transport: provider.transport,
    api_key: provider.api_key,
    api_base: provider.api_base,
    model: model.id,
    modelLabel: model.label,
    optionId: option?.id,
    optionLabel: option?.label,
    assistantLabel: option ? `${model.label} · ${option.label}` : model.label,
    extraRequestConfig
  };
}

function assertNoReservedRequestConfigKeys(config: Record<string, unknown>): void {
  const reservedKeys = ['model', 'messages', 'stream'];
  const conflicts = reservedKeys.filter((key) => key in config);
  if (conflicts.length === 0) {
    return;
  }

  throw new Error(t('host.optionConfigReservedFields', { fields: conflicts.join(', ') }));
}

function resolveAssistantName(config: ResolvedModelConfig): string | undefined {
  return config.assistantLabel.trim() || undefined;
}

function tryResolveAssistantNameFromSelection(
  selection: ChatModelSelection | undefined,
  keyConfig: KeyFileConfig
): string | undefined {
  if (!selection) {
    return undefined;
  }

  try {
    return resolveAssistantName(resolveModelConfig(keyConfig, selection));
  } catch {
    return undefined;
  }
}

async function resolveSessionAssistantName(uri: vscode.Uri, chat: ChatFile): Promise<string | undefined> {
  const fallbackAssistantName = resolveLatestAssistantDisplayName(chat);

  try {
    const keyConfig = await loadKeyConfigForResource(uri);
    return tryResolveAssistantNameFromSelection(resolveStoredChatModelSelection(chat, keyConfig), keyConfig) ?? fallbackAssistantName;
  } catch {
    return fallbackAssistantName;
  }
}

function resolveLatestAssistantDisplayName(chat: ChatFile): string | undefined {
  const activeMessages = getActiveConversationMessages(chat);

  for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
    const message = activeMessages[index];
    if (message.role !== 'assistant') {
      continue;
    }

    const assistantLabel = getMessageCurrentAssistantLabel(message);
    if (typeof assistantLabel === 'string' && assistantLabel.trim()) {
      return assistantLabel.trim();
    }

    if (typeof message.model === 'string' && message.model.trim()) {
      return message.model.trim();
    }
  }

  return undefined;
}

function resolveProjectedAssistantLabel(
  message: Pick<ChatMessageVersion, 'assistantLabel' | 'providerId' | 'model' | 'optionId'>,
  keyConfig: KeyFileConfig
): string | undefined {
  if (!message.providerId || !message.model) {
    return message.assistantLabel;
  }

  return tryResolveAssistantNameFromSelection(
    {
      providerId: message.providerId,
      modelId: message.model,
      optionId: message.optionId
    },
    keyConfig
  ) ?? message.assistantLabel;
}

function resolveAssistantMessageMetadata(config: ResolvedModelConfig): { model: string; providerId: string; optionId?: string } {
  return {
    model: config.model.trim(),
    providerId: config.providerId,
    optionId: config.optionId
  };
}

interface TemplateContext {
  date: string;
  time: string;
  datetime: string;
  modelId: string;
  modelName: string;
}

const MESSAGE_TEMPLATE_VARIABLES: Array<{
  name: string;
  resolve: (context: TemplateContext) => string;
}> = [
  { name: 'date', resolve: (ctx) => ctx.date },
  { name: 'time', resolve: (ctx) => ctx.time },
  { name: 'datetime', resolve: (ctx) => ctx.datetime },
  { name: 'model_id', resolve: (ctx) => ctx.modelId },
  { name: 'model_name', resolve: (ctx) => ctx.modelName }
];

function buildTemplateContext(config: ResolvedModelConfig): TemplateContext {
  const now = new Date();

  return {
    date: now.toLocaleDateString('zh-CN'),
    time: now.toLocaleTimeString('zh-CN'),
    datetime: now.toLocaleString('zh-CN'),
    modelId: config.model,
    modelName: config.modelLabel
  };
}

function applyTemplateVariables(template: string, context: TemplateContext): string {
  let result = template;

  for (const variable of MESSAGE_TEMPLATE_VARIABLES) {
    result = replaceTemplateToken(result, variable.name, variable.resolve(context));
  }

  return result;
}

function applyMessageTemplate(template: string, messageContent: string, context: TemplateContext): string {
  return replaceTemplateToken(applyTemplateVariables(template, context), 'message', messageContent);
}

function appendModelTextContentPart(parts: Array<Record<string, unknown>>, text: string): void {
  if (!text) {
    return;
  }

  const previousPart = parts[parts.length - 1];
  if (previousPart?.type === 'text' && typeof previousPart.text === 'string') {
    previousPart.text += text;
    return;
  }

  parts.push({ type: 'text', text });
}

function appendModelContentParts(
  target: Array<Record<string, unknown>>,
  source: Array<Record<string, unknown>>
): void {
  for (const part of source) {
    if (part.type === 'text' && typeof part.text === 'string') {
      appendModelTextContentPart(target, part.text);
      continue;
    }

    target.push({ ...part });
  }
}

function applyMessageTemplateToModelContent(
  content: string | Array<Record<string, unknown>>,
  message: ChatMessage,
  template: string,
  context: TemplateContext
): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return applyMessageTemplate(template, content, context);
  }

  const templateWithVariables = applyTemplateVariables(template, context);
  const messageTokenPattern = new RegExp(`\{\{\s*${escapeRegExp('message')}\s*\}\}`, 'g');
  if (messageTokenPattern.test(templateWithVariables)) {
    const templatedParts: Array<Record<string, unknown>> = [];
    let cursor = 0;
    messageTokenPattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = messageTokenPattern.exec(templateWithVariables)) !== null) {
      appendModelTextContentPart(templatedParts, templateWithVariables.slice(cursor, match.index));
      appendModelContentParts(templatedParts, content);
      cursor = match.index + match[0].length;
    }

    appendModelTextContentPart(templatedParts, templateWithVariables.slice(cursor));
    return templatedParts;
  }

  const bodyTextParts = getMessageCurrentBody(message).parts
    .filter((part): part is Extract<ChatMessageBodyPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text);
  const bodyText = bodyTextParts
    .join('')
    .trim();
  const templatedText = applyMessageTemplate(template, bodyText, context).trim();
  let bodyTextIndex = 0;
  const preservedParts = content.filter((part) => {
    if (part.type !== 'text') {
      return true;
    }

    const text = typeof part.text === 'string' ? part.text : '';
    if (bodyTextIndex < bodyTextParts.length && text === bodyTextParts[bodyTextIndex]) {
      bodyTextIndex += 1;
      return false;
    }

    return true;
  });

  return templatedText
    ? [{ type: 'text', text: templatedText }, ...preservedParts]
    : preservedParts;
}

async function createModelRequestMessages(
  document: vscode.TextDocument,
  messages: ChatMessage[],
  chat: ChatFile,
  config: ResolvedModelConfig,
  commonConfigs: CommonConfigsFile
): Promise<Array<{ content: string | Array<Record<string, unknown>>; role: 'assistant' | 'system' | 'user' }>> {
  const modelMessages: Array<{ content: string | Array<Record<string, unknown>>; role: 'assistant' | 'system' | 'user' }> = [];

  const systemPrompt = resolveEffectiveSystemPrompt(chat, commonConfigs);
  if (systemPrompt) {
    modelMessages.push({
      role: 'system',
      content: systemPrompt
    });
  }

  const messageTemplate = resolveEffectiveMessageTemplate(chat, commonConfigs);
  const templateContext = messageTemplate ? buildTemplateContext(config) : undefined;

  for (const message of messages) {
    let content = await createModelMessageContent(document, message);

    if (message.role === 'user' && messageTemplate && templateContext) {
      content = applyMessageTemplateToModelContent(content, message, messageTemplate, templateContext);
    }

    modelMessages.push({
      role: message.role,
      content
    });
  }

  return modelMessages;
}

async function createModelMessageContent(
  document: vscode.TextDocument,
  message: ChatMessage
): Promise<string | Array<Record<string, unknown>>> {
  const currentContent = getMessageCurrentContent(message);

  if (message.role !== 'user') {
    return currentContent;
  }

  const body = getMessageCurrentBody(message);
  const attachments = getMessageCurrentAttachments(message);
  if (!body.parts.some((part) => part.type === 'attachment_ref')) {
    return currentContent;
  }

  const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const contentParts: Array<Record<string, unknown>> = [];
  for (const part of body.parts) {
    if (part.type === 'text') {
      if (!part.text.trim()) {
        continue;
      }

      contentParts.push({
        type: 'text',
        text: part.text
      });
      continue;
    }

    const attachment = attachmentById.get(part.attachmentId);
    if (!attachment) {
      contentParts.push({
        type: 'text',
        text: t('host.attachmentLostWithId', { id: part.attachmentId })
      });
      continue;
    }

    const relativePath = normalizeStoredAssetPath(attachment.assetPath);

    let bytes: Uint8Array;
    try {
      const assetUri = await resolveAssetFileUri(document, relativePath);
      bytes = await vscode.workspace.fs.readFile(assetUri);
    } catch {
      throw new Error(t('host.attachmentResourceNotFound', { path: relativePath }));
    }

    if (attachment.kind === 'image') {
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: createImageDataUrl(getImageMimeTypeForPath(relativePath), bytes),
          detail: 'auto'
        }
      });
      continue;
    }

    contentParts.push({
      type: 'text',
      text: await createModelTextForFileAttachment(attachment, bytes)
    });
  }

  return contentParts.length > 0 ? contentParts : currentContent;
}

async function createModelTextForFileAttachment(attachment: ChatAttachment, bytes: Uint8Array): Promise<string> {
  return createModelTextForParsedFileAttachment({
    attachment,
    bytes,
    formatBytes,
    isTextualAttachment,
    decodeUtf8,
    t
  });
}

function getMessagesForModel(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (message) => message.status !== 'pending' && message.status !== 'error' && message.status !== 'canceled'
  );
}

function appendMessageToChat(chat: ChatFile, parentId: string | undefined, message: ChatMessage): ChatFile {
  const nextMessage: ChatMessage = {
    ...message,
    parentId,
    childIds: message.childIds ?? []
  };
  const nextMessages = [...chat.messages, nextMessage];
  const nextRootMessageIds = [...chat.rootMessageIds];

  if (parentId) {
    const parentIndex = nextMessages.findIndex((candidate) => candidate.id === parentId);
    if (parentIndex < 0) {
      throw new Error(t('host.parentNodeForNewMessageMissing'));
    }

    const parentMessage = nextMessages[parentIndex];
    nextMessages[parentIndex] = {
      ...parentMessage,
      childIds: [...(parentMessage.childIds ?? []), nextMessage.id]
    };
  } else {
    nextRootMessageIds.push(nextMessage.id);
  }

  const nextActiveChildByParentId = withActiveChildSelection(chat.activeChildByParentId, parentId, nextMessage.id);

  return {
    ...chat,
    updatedAt: new Date().toISOString(),
    rootMessageIds: nextRootMessageIds,
    activeChildByParentId: nextActiveChildByParentId,
    messages: nextMessages
  };
}

function setActiveSiblingSelection(chat: ChatFile, parentId: string | undefined, messageId: string): ChatFile {
  return {
    ...chat,
    updatedAt: new Date().toISOString(),
    activeChildByParentId: withActiveChildSelection(chat.activeChildByParentId, parentId, messageId)
  };
}

function collectDescendantMessageIds(chat: ChatFile, rootMessageId: string): Set<string> {
  const messageMap = getMessageMap(chat);
  const visited = new Set<string>();
  const stack = [rootMessageId];

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId || visited.has(currentId)) {
      continue;
    }

    visited.add(currentId);

    const message = messageMap.get(currentId);
    if (!message) {
      continue;
    }

    for (const childId of message.childIds ?? []) {
      stack.push(childId);
    }
  }

  return visited;
}

function removeMessageById(chat: ChatFile, messageId: string): ChatFile {
  const target = chat.messages.find((message) => message.id === messageId);
  if (!target) {
    return chat;
  }

  const removeIds = collectDescendantMessageIds(chat, messageId);
  const nextMessages = chat.messages
    .filter((message) => !removeIds.has(message.id))
    .map((message) => ({
      ...message,
      childIds: (message.childIds ?? []).filter((childId) => !removeIds.has(childId))
    }));

  const nextRootMessageIds = chat.rootMessageIds.filter((rootId) => !removeIds.has(rootId));
  const nextActiveChildByParentId = { ...chat.activeChildByParentId };

  for (const removeId of removeIds) {
    delete nextActiveChildByParentId[removeId];
  }

  ensureActiveSelection(nextActiveChildByParentId, ROOT_BRANCH_PARENT_ID, nextRootMessageIds);
  for (const message of nextMessages) {
    ensureActiveSelection(nextActiveChildByParentId, message.id, message.childIds ?? []);
  }

  return {
    ...chat,
    updatedAt: new Date().toISOString(),
    rootMessageIds: nextRootMessageIds,
    activeChildByParentId: nextActiveChildByParentId,
    messages: nextMessages
  };
}

function getDeletionPreview(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  return normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized;
}

function createTreeChatFromLinearMessages(title: string, messages: ChatMessage[]): ChatFile {
  const timestamp = new Date().toISOString();
  const nextMessages = messages.map((message, index) => ({
    ...message,
    parentId: index > 0 ? messages[index - 1]?.id : undefined,
    childIds: index < messages.length - 1 && messages[index + 1] ? [messages[index + 1].id] : []
  }));
  const rootMessageIds = nextMessages[0] ? [nextMessages[0].id] : [];
  const activeChildByParentId: Record<string, string> = {};

  ensureActiveSelection(activeChildByParentId, ROOT_BRANCH_PARENT_ID, rootMessageIds);
  for (const message of nextMessages) {
    ensureActiveSelection(activeChildByParentId, message.id, message.childIds ?? []);
  }

  return {
    version: CHAT_FILE_VERSION,
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
    rootMessageIds,
    activeChildByParentId,
    messages: nextMessages
  };
}

function updateMessageById(
  chat: ChatFile,
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage
): ChatFile {
  const messageIndex = chat.messages.findIndex((message) => message.id === messageId);
  if (messageIndex < 0) {
    throw new Error(t('host.chatMessageToUpdateMissing'));
  }

  const nextMessages = [...chat.messages];
  nextMessages[messageIndex] = updater(chat.messages[messageIndex]);

  return {
    ...chat,
    updatedAt: new Date().toISOString(),
    messages: nextMessages
  };
}

function trimChatFileSuffix(fileName: string): string {
  return fileName.endsWith(CHAT_FILE_EXTENSION)
    ? fileName.slice(0, -CHAT_FILE_EXTENSION.length)
    : fileName;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

function getWorkspaceFolderUriForDocument(document: vscode.TextDocument): vscode.Uri | undefined {
  return vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
}

function getPreferredWorkspaceFolderUri(resourceUri?: vscode.Uri): vscode.Uri | undefined {
  if (resourceUri) {
    const resourceWorkspaceFolder = vscode.workspace.getWorkspaceFolder(resourceUri)?.uri;
    if (resourceWorkspaceFolder) {
      return resourceWorkspaceFolder;
    }
  }

  const activeDocumentUri = vscode.window.activeTextEditor?.document.uri;
  if (activeDocumentUri) {
    const activeWorkspaceFolder = vscode.workspace.getWorkspaceFolder(activeDocumentUri)?.uri;
    if (activeWorkspaceFolder) {
      return activeWorkspaceFolder;
    }
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function getHomeDirectoryUri(): vscode.Uri {
  return vscode.Uri.file(os.homedir());
}

function dedupeUriList(uris: readonly vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  const uniqueUris: vscode.Uri[] = [];

  for (const uri of uris) {
    const uriKey = getUriIdentityKey(uri);
    if (seen.has(uriKey)) {
      continue;
    }

    seen.add(uriKey);
    uniqueUris.push(uri);
  }

  return uniqueUris;
}

function getUriIdentityKey(uri: vscode.Uri): string {
  const normalizedPath = path.normalize(uri.fsPath);
  return process.platform === 'win32'
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

const utf8Decoder = new TextDecoder('utf-8');
function decodeUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

function parseJsoncDocument(text: string, sourceLabel: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(t('host.sourceInvalidJson', { label: sourceLabel, code: printParseErrorCode(first.error), offset: first.offset }));
  }
  return value;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRawErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return undefined;
}

function extractUnsupportedParameterName(message: string): string | undefined {
  const patterns = [
    /unexpected keyword argument ['"]([^'"]+)['"]/i,
    /unsupported parameter[:\s]+['"]?([^'"\s,)\]}]+)['"]?/i,
    /unknown parameter[:\s]+['"]?([^'"\s,)\]}]+)['"]?/i,
    /unrecognized request argument supplied:\s*['"]?([^'"\s,)\]}]+)['"]?/i,
    /unknown field[:\s]+['"]?([^'"\s,)\]}]+)['"]?/i
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

function isUnsupportedRequestParameterError(error: unknown, parameterNames: string[]): boolean {
  const rawMessage = getRawErrorMessage(error);
  if (!rawMessage) {
    return false;
  }

  const loweredMessage = rawMessage.toLowerCase();
  const extractedParameter = extractUnsupportedParameterName(rawMessage)?.toLowerCase();

  return parameterNames.some((parameterName) => {
    const loweredParameterName = parameterName.toLowerCase();

    if (extractedParameter) {
      return extractedParameter === loweredParameterName
        || extractedParameter.endsWith(`.${loweredParameterName}`)
        || extractedParameter.startsWith(`${loweredParameterName}.`);
    }

    return loweredMessage.includes(loweredParameterName)
      && /(unsupported|unexpected|unknown|unrecognized|not support|not supported)/i.test(rawMessage);
  });
}

function toErrorMessage(error: unknown): string {
  const rawMessage = getRawErrorMessage(error);
  if (rawMessage) {
    const unsupportedRequestParameter = extractUnsupportedParameterName(rawMessage);
    if (unsupportedRequestParameter) {
      return t('host.unsupportedRequestParameter', { param: unsupportedRequestParameter });
    }

    return rawMessage;
  }

  return t('host.unknownErrorOccurred');
}

function getNonce(): string {
  return crypto.randomBytes(24).toString('base64').replace(/[+/=]/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceTemplateToken(template: string, tokenName: string, replacement: string): string {
  const pattern = new RegExp(`\\{\\{\\s*${escapeRegExp(tokenName)}\\s*\\}\\}`, 'g');
  return template.replace(pattern, () => replacement);
}
