import * as path from 'path';
import * as vscode from 'vscode';
import { getLocale, t } from '../shared/i18n';
import {
  CHAT_COMMON_CONFIGS_FILE_NAME,
  CHAT_DIRECTORY_NAME,
  CHAT_FILE_EXTENSION,
  CHAT_FILE_GLOB,
  DEFAULT_CHAT_TITLE,
  SESSIONS_VIEW_VISIBILITY_CONTEXT,
  VIEW_TYPE,
  createDefaultCommonConfigsFileContent,
  createDefaultKeyFileContent,
  createEmptyChatFile,
  createUniqueChatFileUri,
  createUntitledChatFileUri,
  findFirstExistingUri,
  generateChatTitleWithAI,
  getActiveConversationMessages,
  getChatDataDirectoryUriForBaseDirectory,
  getChatDataFileCandidateUris,
  getCommonConfigsFileUriForDirectory,
  getDeletionPreview,
  getKeyFileUriForDirectory,
  getMessageCurrentContent,
  getPreferredNewChatBaseDirectoryUri,
  loadKeyConfig,
  replaceDocumentContent,
  resolveChatDataDirectoryResolution,
  resolveSessionAssistantName,
  safeParseChatDocument,
  serializeChatFile,
  toErrorMessage,
  trimChatFileSuffix
} from './chat';
import type {
  ChatFile,
  ChatSessionSummary,
  ChatSessionTreeNode
} from './chat';

export class ChatSessionsProvider implements vscode.TreeDataProvider<ChatSessionTreeNode> {
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

export async function createNewChatFile(resourceUri?: vscode.Uri): Promise<void> {
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

export async function manageProviderConfigCommand(resourceUri?: vscode.Uri): Promise<void> {
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

export async function manageCommonConfigCommand(resourceUri?: vscode.Uri): Promise<void> {
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

export async function renameChatTitle(targetUri: vscode.Uri): Promise<void> {
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

export async function regenerateChatTitle(targetUri: vscode.Uri): Promise<boolean> {
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

export function getChatTitleSourceContent(chat: ChatFile): string | undefined {
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

export function resolveSingleSessionCommandTargetUri(
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

export async function resolveDeleteChatSessionTargets(
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

export function getCommandSelectedSessions(selectedItems?: readonly ChatSessionTreeNode[]): ChatSessionSummary[] {
  return (selectedItems ?? []).filter((item): item is ChatSessionSummary => item.kind === 'session');
}

export async function confirmDeleteChatSessions(targets: readonly ChatSessionSummary[]): Promise<boolean> {
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

export async function closeChatEditors(targetUris: readonly vscode.Uri[]): Promise<void> {
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

export function getTabInputUri(input: unknown): vscode.Uri | undefined {
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

export async function loadChatSessionSummaries(): Promise<ChatSessionSummary[]> {
  const files = await vscode.workspace.findFiles(CHAT_FILE_GLOB);
  const summaries = await Promise.all(files.map((uri) => createChatSessionSummary(uri)));

  return summaries.sort((left, right) => compareIsoDesc(left.updatedAt, right.updatedAt) || compareSessionLabels(left.title, right.title));
}

export async function setSessionsViewVisibilityContext(isVisible: boolean): Promise<void> {
  await vscode.commands.executeCommand('setContext', SESSIONS_VIEW_VISIBILITY_CONTEXT, isVisible);
}

export async function hasAnyChatDataDirectoryInWorkspace(): Promise<boolean> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  for (const workspaceFolder of workspaceFolders) {
    if (await workspaceContainsChatDataDirectory(workspaceFolder.uri)) {
      return true;
    }
  }

  return false;
}

export async function workspaceContainsChatDataDirectory(baseUri: vscode.Uri): Promise<boolean> {
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

export function shouldSkipChatDirectoryScan(name: string): boolean {
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

export async function createChatSessionSummary(uri: vscode.Uri): Promise<ChatSessionSummary> {
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

export function buildChatSessionTree(summaries: ChatSessionSummary[]): ChatSessionTreeNode[] {
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

export function buildChatSessionFolderChildren(
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

export function hasMatchingDirectorySegments(summary: ChatSessionSummary, parentSegments: string[]): boolean {
  return parentSegments.every((segment, index) => summary.directorySegments[index] === segment);
}

export function compareSessionLabels(left: string, right: string): number {
  return left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

export function getSessionDirectoryPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const directoryPath = path.posix.dirname(normalized);
  return directoryPath === '.' ? '' : directoryPath;
}

export function fileStatTimeToIso(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

export function buildSessionPreview(chat: ChatFile): string {
  const messages = getActiveConversationMessages(chat);
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = normalizeSessionPreviewText(getMessageCurrentContent(messages[i]));
    if (text) return truncateSessionPreviewText(text);
  }
  return t('host.emptyContentParenthesis');
}

export function normalizeSessionPreviewText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncateSessionPreviewText(value: string, maxLength: number = 92): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

export function getSessionRelativePath(uri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return path.basename(uri.fsPath);
  }

  return path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
}

export function compareIsoDesc(left: string, right: string): number {
  return new Date(right).getTime() - new Date(left).getTime();
}

export function formatSessionUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return t('host.timeUnknown');
  }

  const now = new Date();
  return new Intl.DateTimeFormat(getLocale(), {
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

export function createSessionTooltip(session: ChatSessionSummary): vscode.MarkdownString {
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

export function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
}

export function getActiveChatEditorDocumentUri(): vscode.Uri | undefined {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && activeEditor.document.uri.fsPath.endsWith(CHAT_FILE_EXTENSION)) {
    return activeEditor.document.uri;
  }

  return undefined;
}

export async function reopenActiveChatTextEditorIfNeeded(): Promise<void> {
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

export function resolveRawJsonTargetUri(input?: ChatSessionSummary | vscode.Uri): vscode.Uri | undefined {
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

