import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { applyLegacyChatCompatibility } from '../../chatCompat';
import { t } from '../../shared/i18n';
import {
  CHAT_FILE_EXTENSION,
  CHAT_FILE_VERSION,
  ROOT_BRANCH_PARENT_ID
} from './types';
import type {
  ChatAttachment,
  ChatFile,
  ChatMessage,
  ChatMessageBody,
  ChatMessageBodyPart,
  ChatMessageStatus,
  ChatMessageVersion,
  ChatModelSelection,
  ChatRole,
  ChatTokenStats,
  PersistedChatFile,
  PersistedChatMessage,
  PersistedChatMessageVersion,
  PersistedChatModelSelectionJSON
} from './types';
import {
  isObject,
  normalizeInheritableTextField,
  normalizeModelSelectionField,
  normalizeOptionalStringOrNull,
  normalizeTokenStats,
  toErrorMessage
} from './utils';
import {
  normalizeStoredAssetPath
} from './content';

export function createEmptyChatFile(title: string): ChatFile {
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

export function appendTextBodyPart(parts: ChatMessageBodyPart[], text: string | undefined): void {
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

export function normalizeChatMessageBodyParts(parts: ChatMessageBodyPart[]): ChatMessageBodyPart[] {
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

export function createChatMessageBody(parts: ChatMessageBodyPart[]): ChatMessageBody {
  return { parts: normalizeChatMessageBodyParts(parts) };
}

export function safeParseChatDocument(text: string, fallbackTitle: string): { chat: ChatFile; error?: string } {
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

export function parseChatDocument(text: string, fallbackTitle: string): ChatFile {
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

export function normalizeMessage(raw: unknown): ChatMessage | undefined {
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

export function normalizeChildIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const childIds = raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return childIds.length > 0 ? childIds : undefined;
}

export function normalizeChatTree(
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

export function ensureActiveSelection(activeChildByParentId: Record<string, string>, parentKey: string, childIds: string[]): void {
  if (childIds.length === 0) {
    delete activeChildByParentId[parentKey];
    return;
  }

  if (!childIds.includes(activeChildByParentId[parentKey])) {
    activeChildByParentId[parentKey] = childIds[childIds.length - 1];
  }
}

export function getMessageMap(chat: ChatFile): Map<string, ChatMessage> {
  return new Map(chat.messages.map((message) => [message.id, message]));
}

export function getBranchParentKey(parentId: string | undefined): string {
  return parentId ?? ROOT_BRANCH_PARENT_ID;
}

export function getActiveChildSelectionId(
  chat: Pick<ChatFile, 'activeChildByParentId'>,
  parentId: string | undefined
): string | undefined {
  return chat.activeChildByParentId[getBranchParentKey(parentId)];
}

export function withActiveChildSelection(
  activeChildByParentId: Record<string, string>,
  parentId: string | undefined,
  messageId: string
): Record<string, string> {
  return {
    ...activeChildByParentId,
    [getBranchParentKey(parentId)]: messageId
  };
}

export function getSiblingIds(chat: ChatFile, parentId: string | undefined): string[] {
  if (!parentId) {
    return [...chat.rootMessageIds];
  }

  const messageMap = getMessageMap(chat);
  return [...(messageMap.get(parentId)?.childIds ?? [])];
}

export function getSelectedChildId(chat: ChatFile, parentId: string | undefined, childIds: string[]): string | undefined {
  if (childIds.length === 0) {
    return undefined;
  }

  const selectedId = getActiveChildSelectionId(chat, parentId);
  return selectedId && childIds.includes(selectedId) ? selectedId : childIds[childIds.length - 1];
}

export function getActiveConversationMessages(chat: ChatFile): ChatMessage[] {
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

export function getConversationPathToMessage(chat: ChatFile, messageId: string): ChatMessage[] {
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

export function activateMessagePath(chat: ChatFile, messageId: string): ChatFile {
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

export function normalizeMessageVersions(
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

export function normalizeMessageBody(raw: unknown): ChatMessageBody | undefined {
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

export function normalizeMessageAttachments(raw: unknown): ChatAttachment[] {
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

export function normalizeCurrentVersionId(raw: unknown, versions: Array<Pick<ChatMessageVersion, 'id'>> | undefined): string | undefined {
  if (!versions || versions.length === 0) {
    return undefined;
  }

  if (typeof raw === 'string' && versions.some((version) => version.id === raw)) {
    return raw;
  }

  return versions[versions.length - 1]?.id;
}

export function getMessageCurrentVersion(
  message: Pick<ChatMessage, 'versions' | 'currentVersionId'>
): ChatMessageVersion | undefined {
  return getVersionById(message.versions, message.currentVersionId);
}

export function getMessageCurrentContent(
  message: Pick<ChatMessage, 'content' | 'versions' | 'currentVersionId'>
): string {
  return getMessageCurrentVersion(message)?.content ?? message.content;
}

export function getMessageCurrentBody(
  message: Pick<ChatMessage, 'body' | 'versions' | 'currentVersionId'>
): ChatMessageBody {
  return getMessageCurrentVersion(message)?.body ?? message.body;
}

export function getMessageCurrentAttachments(
  message: Pick<ChatMessage, 'attachments' | 'versions' | 'currentVersionId'>
): ChatAttachment[] {
  return getMessageCurrentVersion(message)?.attachments ?? message.attachments ?? [];
}

export function getMessageCurrentAssistantLabel(
  message: Pick<ChatMessage, 'versions' | 'currentVersionId'>
): string | undefined {
  return getMessageCurrentVersion(message)?.assistantLabel;
}

export function isCurrentMessageContent(
  message: Pick<ChatMessage, 'content' | 'versions' | 'currentVersionId'>,
  content: string
): boolean {
  return getMessageCurrentContent(message) === content;
}

export function isCurrentMessageVersion(
  message: Pick<ChatMessage, 'versions' | 'currentVersionId'>,
  versionId: string
): boolean {
  return getMessageCurrentVersion(message)?.id === versionId;
}

export function getVersionById(
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

export function findVersionById(
  versions: ChatMessageVersion[] | undefined,
  versionId: string | undefined
): ChatMessageVersion | undefined {
  if (!versions || versions.length === 0 || !versionId) {
    return undefined;
  }

  return versions.find((version) => version.id === versionId);
}

export function createMessageVersion(
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

export function appendMessageVersion(
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

export function setMessageCurrentVersion(message: ChatMessage, versionId: string): ChatMessage {
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

export function setMessageCurrentContent(
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

export function setMessageCurrentStructuredContent(
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

export function createTextMessageBody(content: string): ChatMessageBody {
  return createChatMessageBody(content ? [{ type: 'text', text: content }] : []);
}

export function getBodyPlainText(body: ChatMessageBody, attachments: ChatAttachment[] = []): string {
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

export function createClipboardMarkdownForMessage(
  message: Pick<ChatMessage, 'body' | 'attachments' | 'versions' | 'currentVersionId'>
): string {
  return createClipboardMarkdownForBody(getMessageCurrentBody(message), getMessageCurrentAttachments(message));
}

export function createClipboardMarkdownForVersion(version: ChatMessageVersion): string {
  return createClipboardMarkdownForBody(version.body, version.attachments ?? []);
}

export function createClipboardMarkdownForBody(body: ChatMessageBody, attachments: ChatAttachment[] = []): string {
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

export function sanitizeMarkdownLabel(value: string): string {
  return value.replace(/[\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim() || 'attachment';
}

export function unescapeMarkdownLabel(value: string): string {
  return value.replace(/\\([\\\[\]])/g, '$1').replace(/\s+/g, ' ').trim();
}

export function createPersistedMessageVersion(
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

export function persistMessageVersion(version: ChatMessageVersion): PersistedChatMessageVersion {
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

export function canPersistVersionAsPlainContent(
  version: Pick<ChatMessageVersion, 'content' | 'body' | 'attachments'>
): boolean {
  if ((version.attachments?.length ?? 0) > 0) {
    return false;
  }

  const textOnlyContent = getTextOnlyBodyContent(version.body);
  return textOnlyContent !== undefined && textOnlyContent === version.content;
}

export function getTextOnlyBodyContent(body: ChatMessageBody): string | undefined {
  let content = '';
  for (const part of body.parts) {
    if (part.type !== 'text') {
      return undefined;
    }

    content += part.text;
  }

  return content;
}

export function getPersistedMessageVersions(message: ChatMessage): PersistedChatMessageVersion[] {
  const versions = message.versions ?? [];
  if (versions.length > 0) {
    return versions.map((version) => persistMessageVersion(version));
  }

  return [persistMessageVersion(createPersistedMessageVersion(message))];
}

export function createPersistedChatMessage(message: ChatMessage): PersistedChatMessage {
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

export function createPersistedChatFile(chat: ChatFile): PersistedChatFile {
  const { messages, modelSelection, ...rest } = chat;

  return {
    ...rest,
    ...(modelSelection ? { modelSelection: chatModelSelectionToJSON(modelSelection) } : {}),
    messages: messages.map((message) => createPersistedChatMessage(message))
  };
}

export function chatModelSelectionToJSON(selection: ChatModelSelection): PersistedChatModelSelectionJSON {
  return {
    model: selection.modelId,
    providerId: selection.providerId,
    optionId: selection.optionId
  };
}

export function serializeChatFile(chat: ChatFile): string {
  return `${JSON.stringify(createPersistedChatFile(chat), null, 2)}\n`;
}

export function createMessage(
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

export async function replaceDocumentContent(document: vscode.TextDocument, nextContent: string): Promise<void> {
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

export function normalizeMessageStatus(value: unknown): ChatMessageStatus | undefined {
  if (value === 'pending' || value === 'completed' || value === 'error' || value === 'canceled') {
    return value;
  }

  return undefined;
}

export function normalizeDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return value;
}

export function appendMessageToChat(chat: ChatFile, parentId: string | undefined, message: ChatMessage): ChatFile {
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

export function setActiveSiblingSelection(chat: ChatFile, parentId: string | undefined, messageId: string): ChatFile {
  return {
    ...chat,
    updatedAt: new Date().toISOString(),
    activeChildByParentId: withActiveChildSelection(chat.activeChildByParentId, parentId, messageId)
  };
}

export function collectDescendantMessageIds(chat: ChatFile, rootMessageId: string): Set<string> {
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

export function removeMessageById(chat: ChatFile, messageId: string): ChatFile {
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

export function getDeletionPreview(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  return normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized;
}

export function createTreeChatFromLinearMessages(title: string, messages: ChatMessage[]): ChatFile {
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

export function updateMessageById(
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

export function trimChatFileSuffix(fileName: string): string {
  return fileName.endsWith(CHAT_FILE_EXTENSION)
    ? fileName.slice(0, -CHAT_FILE_EXTENSION.length)
    : fileName;
}

export function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}
