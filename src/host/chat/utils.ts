import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parse as parseJsonc, ParseError, printParseErrorCode } from 'jsonc-parser/lib/esm/main.js';
import { t } from '../../shared/i18n';
import {
  CHAT_DIRECTORY_NAME,
  CHAT_FILE_EXTENSION
} from './types';
import type {
  ChatDataDirectoryResolution,
  ChatModelSelection,
  ChatTokenStats,
  InheritableTextField
} from './types';
import {
  trimChatFileSuffix
} from './document';

export function getActiveChatEditorDocumentUri(): vscode.Uri | undefined {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && activeEditor.document.uri.fsPath.endsWith(CHAT_FILE_EXTENSION)) {
    return activeEditor.document.uri;
  }

  return undefined;
}

export function getPreferredNewChatBaseDirectoryUri(resourceUri?: vscode.Uri): vscode.Uri {
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

export async function createUniqueChatFileUri(baseDirectoryUri: vscode.Uri): Promise<vscode.Uri> {
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

export function createUntitledChatFileUri(targetUri: vscode.Uri): vscode.Uri {
  return targetUri.with({ scheme: 'untitled' });
}

export function createGeneratedChatFileName(now: Date = new Date()): string {
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

export async function resolveChatDataDirectoryResolution(resourceUri?: vscode.Uri): Promise<ChatDataDirectoryResolution> {
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

export async function getDirectoryUriFromResource(resourceUri: vscode.Uri): Promise<vscode.Uri> {
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

export function normalizeOptionalStringOrNull(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  return undefined;
}

export function normalizeInheritableTextField(value: unknown): InheritableTextField | undefined {
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

export function normalizeModelSelectionField(raw: unknown): ChatModelSelection | undefined {
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

export function getChatDataDirectoryUriForBaseDirectory(baseDirectoryUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(baseDirectoryUri, CHAT_DIRECTORY_NAME);
}

export async function findFirstExistingUri(candidateUris: readonly vscode.Uri[]): Promise<vscode.Uri | undefined> {
  for (const candidateUri of candidateUris) {
    if (await uriExists(candidateUri)) {
      return candidateUri;
    }
  }

  return undefined;
}

export function findContainingChatDataBasePath(resourcePath: string): string | undefined {
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

export async function getNextBranchFileUri(sourceUri: vscode.Uri): Promise<vscode.Uri> {
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

export function normalizeTokenStats(raw: unknown): ChatTokenStats | undefined {
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

export function normalizeTokenCount(value: unknown): number | undefined {
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

export function getWorkspaceFolderUriForDocument(document: vscode.TextDocument): vscode.Uri | undefined {
  return vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
}

export function getPreferredWorkspaceFolderUri(resourceUri?: vscode.Uri): vscode.Uri | undefined {
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

export function getHomeDirectoryUri(): vscode.Uri {
  return vscode.Uri.file(os.homedir());
}

export function dedupeUriList(uris: readonly vscode.Uri[]): vscode.Uri[] {
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

export function getUriIdentityKey(uri: vscode.Uri): string {
  const normalizedPath = path.normalize(uri.fsPath);
  return process.platform === 'win32'
    ? normalizedPath.toLowerCase()
    : normalizedPath;
}

export async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export const utf8Decoder = new TextDecoder('utf-8');

export function decodeUtf8(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

export function parseJsoncDocument(text: string, sourceLabel: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(t('host.sourceInvalidJson', { label: sourceLabel, code: printParseErrorCode(first.error), offset: first.offset }));
  }
  return value;
}

export function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getRawErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return undefined;
}

export function extractUnsupportedParameterName(message: string): string | undefined {
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

export function isUnsupportedRequestParameterError(error: unknown, parameterNames: string[]): boolean {
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

export function toErrorMessage(error: unknown): string {
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

export function getNonce(): string {
  return crypto.randomBytes(24).toString('base64').replace(/[+/=]/g, '');
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function replaceTemplateToken(template: string, tokenName: string, replacement: string): string {
  const pattern = new RegExp(`\\{\\{\\s*${escapeRegExp(tokenName)}\\s*\\}\\}`, 'g');
  return template.replace(pattern, () => replacement);
}
