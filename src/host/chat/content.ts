import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import hljs from 'highlight.js/lib/common';
import MarkdownIt from 'markdown-it';
import { extension as getMimeExtension, lookup as lookupMimeType } from 'mime-types';
import { t } from '../../shared/i18n';
import {
  ASSISTANT_IMAGE_FETCH_TIMEOUT_MS,
  CHAT_ASSETS_DIRECTORY_NAME,
  CHAT_DIRECTORY_NAME,
  GENERIC_BINARY_MIME_TYPE,
  SUPPORTED_IMAGE_MIME_TYPES
} from './types';
import type {
  ChatAttachment,
  ChatAttachmentKind,
  ChatFile,
  ChatMessage,
  ChatMessageBody,
  ChatMessageBodyPart,
  IsTextFileFunction,
  KeyFileConfig,
  WebviewChatContentPart,
  WebviewChatFile,
  WebviewIncomingAttachment
} from './types';
import {
  getChatDataDirectoryUriForBaseDirectory,
  resolveChatDataDirectoryResolution,
  uriExists
} from './utils';
import {
  appendTextBodyPart,
  createChatMessageBody,
  createClipboardMarkdownForBody,
  createTextMessageBody,
  getActiveConversationMessages,
  getBodyPlainText,
  getMessageCurrentAttachments,
  getMessageCurrentBody,
  getMessageCurrentContent,
  getSiblingIds,
  sanitizeMarkdownLabel,
  unescapeMarkdownLabel
} from './document';
import {
  resolveProjectedAssistantLabel
} from './config';

export const katex = require('katex');

export const texmath = require('markdown-it-texmath');

export const MARKDOWN_LINK_SCHEMES = new Set(['http', 'https', 'mailto']);

export const markdownRenderer = createMarkdownRenderer();

export let isTextFileLoader: Promise<IsTextFileFunction> | undefined;

export async function createWebviewChatFile(
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

export async function createWebviewChatMessage(
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

export function createMarkdownRenderer(): MarkdownIt {
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

export function renderHighlightedCodeBlock(md: MarkdownIt, source: string, info: string): string {
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

export function normalizeFenceLanguageInfo(info: string): {
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

export async function renderMarkdownToHtml(source: string | undefined): Promise<string | undefined> {
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

export async function openExternalMarkdownLink(href: string): Promise<void> {
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

export async function createWebviewContentParts(
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

export function hasMeaningfulMessageContent(content: string): boolean {
  return content.trim().length > 0;
}

export async function composeUserMessageBody(
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

export const LOCAL_MARKDOWN_ASSET_LINK_REGEX = /(!?)\[([^\]\r\n]*)\]\(([^)\r\n]+)\)/g;

export async function parseLocalMarkdownAssetAttachments(
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

export async function createClipboardMarkdownAttachmentImport(
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

export function normalizePastedMarkdownAssetPath(rawDestination: string): string | undefined {
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

export function normalizeMarkdownLinkDestination(rawDestination: string): string {
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

export async function createWebviewIncomingAttachmentFromStoredAsset(
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

export async function createAttachmentFromStoredAsset(
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

export async function createMessageBodyFromAssistantContent(
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

export async function createAssistantImageAttachmentFromMarkdownDestination(
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

export async function createAssistantImageAttachmentFromDataUrl(
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

export async function fetchAssistantImageAttachment(
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

export function createAssistantImageName(label: string, fallbackName: string, mimeType: string): string {
  const candidate = sanitizeMarkdownLabel(label) !== 'attachment'
    ? sanitizeMarkdownLabel(label)
    : sanitizeMarkdownLabel(fallbackName) !== 'attachment'
      ? sanitizeMarkdownLabel(fallbackName)
      : 'assistant-image';
  return normalizeAttachmentOriginalName(candidate, normalizeMimeType(mimeType), 'image');
}

export function getChatDirectoryUri(document: vscode.TextDocument): vscode.Uri {
  return vscode.Uri.file(path.dirname(document.uri.fsPath));
}

export function getChatDataDirectoryUri(document: vscode.TextDocument): vscode.Uri {
  return getChatDataDirectoryUriForBaseDirectory(getChatDirectoryUri(document));
}

export function getChatAssetsDirectoryUri(document: vscode.TextDocument): vscode.Uri {
  return vscode.Uri.joinPath(getChatDataDirectoryUri(document), CHAT_ASSETS_DIRECTORY_NAME);
}

export function normalizeStoredAssetPath(relativePath: string): string {
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

export async function resolveAssetFileUri(document: vscode.TextDocument, relativePath: string): Promise<vscode.Uri> {
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

export function getImageMimeTypeForPath(relativePath: string): string {
  const mimeType = getMimeTypeForAssetPath(relativePath);
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(t('host.unsupportedImageExtension', { path: relativePath }));
  }

  return mimeType;
}

export function getMimeTypeForAssetPath(relativePath: string): string {
  return inferMimeTypeFromName(relativePath) ?? GENERIC_BINARY_MIME_TYPE;
}

export function normalizeMimeType(value: string | undefined): string {
  const mimeType = typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
  return mimeType && mimeType.includes('/') ? mimeType : GENERIC_BINARY_MIME_TYPE;
}

export function inferMimeTypeFromName(name: string): string | undefined {
  const mimeType = lookupMimeType(name);
  return mimeType ? normalizeMimeType(mimeType) : undefined;
}

export function normalizeAttachmentMimeType(name: string, mimeType: string): string {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const inferredMimeType = inferMimeTypeFromName(name);

  if (!inferredMimeType) {
    return normalizedMimeType;
  }

  return normalizedMimeType === GENERIC_BINARY_MIME_TYPE ? inferredMimeType : normalizedMimeType;
}

export function inferAttachmentKind(name: string, mimeType: string): ChatAttachmentKind {
  const normalizedMimeType = normalizeAttachmentMimeType(name, mimeType);
  return SUPPORTED_IMAGE_MIME_TYPES.has(normalizedMimeType) ? 'image' : 'file';
}

export function parseAttachmentDataUrl(dataUrl: string): { bytes: Uint8Array; mimeType: string } {
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

export function createImageDataUrl(mimeType: string, bytes: Uint8Array): string {
  return createAttachmentDataUrl(mimeType, bytes);
}

export function createAttachmentDataUrl(mimeType: string, bytes: Uint8Array): string {
  const base64 = toBuffer(bytes).toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

export function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function normalizeAttachmentOriginalName(name: string, mimeType: string, kind: ChatAttachmentKind): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  const fallback = kind === 'image' ? 'image' : 'file';
  const baseName = path.basename(trimmed || fallback).replace(/[\r\n]+/g, ' ').trim() || fallback;
  if (path.extname(baseName)) {
    return baseName;
  }

  return `${baseName}.${getAttachmentExtension(baseName, mimeType, kind)}`;
}

export function getAttachmentExtension(originalName: string, mimeType: string, kind: ChatAttachmentKind): string {
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

export function createChatAttachment(
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

export function createChatAttachmentFromBytes(
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

export function formatBytes(value: number): string {
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

export async function isTextualAttachment(attachment: ChatAttachment, bytes: Uint8Array): Promise<boolean> {
  const buffer = toBuffer(bytes);
  const isTextFile = await getIsTextFile();
  const detectedText = isTextFile(attachment.originalName || attachment.assetPath, buffer);
  if (detectedText !== null) {
    return detectedText;
  }

  const mimeType = normalizeMimeType(attachment.mimeType);
  return mimeType.startsWith('text/') || mimeType.endsWith('+json') || mimeType.endsWith('+xml');
}

export function getIsTextFile(): Promise<IsTextFileFunction> {
  isTextFileLoader ??= import('istextorbinary').then((module) => {
    const typedModule = module as unknown as { isText: IsTextFileFunction };
    return typedModule.isText;
  });
  return isTextFileLoader;
}

export async function persistWebviewAttachments(
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

export async function persistWebviewAttachment(
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

export async function persistAttachmentBytes(
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

export async function validateConversationAttachmentReferences(document: vscode.TextDocument, messages: ChatMessage[]): Promise<void> {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }

    await validateMessageAttachmentReferences(document, message);
  }
}

export async function validateMessageAttachmentReferences(document: vscode.TextDocument, message: ChatMessage): Promise<void> {
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
