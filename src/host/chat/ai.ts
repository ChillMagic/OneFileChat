import * as path from 'path';
import * as vscode from 'vscode';
import OpenAI from 'openai';
import { createModelTextForParsedFileAttachment } from '../../parsers/files';
import { t } from '../../shared/i18n';
import {
  CHAT_TITLE_MAX_LENGTH,
  DEFAULT_CHAT_TITLE,
  TITLE_GENERATION_MAX_CONTEXT_CHARS,
  TITLE_GENERATION_MAX_CONTEXT_LINE_CHARS,
  TITLE_GENERATION_MAX_CONTEXT_MESSAGES,
  TITLE_GENERATION_REQUEST_TIMEOUT_MS,
  TITLE_GENERATION_SYSTEM_PROMPT
} from './types';
import type {
  AssistantResponse,
  ChatAttachment,
  ChatFile,
  ChatMessage,
  ChatMessageBodyPart,
  ChatTokenStats,
  CommonConfigsFile,
  KeyFileConfig,
  ResolveTitleGenerationRequestConfigOptions,
  ResolvedModelConfig
} from './types';
import {
  decodeUtf8,
  escapeRegExp,
  isObject,
  isUnsupportedRequestParameterError,
  normalizeSessionPreviewText,
  normalizeTokenStats,
  replaceTemplateToken,
  truncateSessionPreviewText
} from './utils';
import {
  getActiveConversationMessages,
  getMessageCurrentAttachments,
  getMessageCurrentBody,
  getMessageCurrentContent,
  parseChatDocument,
  replaceDocumentContent,
  sanitizeMarkdownLabel,
  serializeChatFile,
  trimChatFileSuffix
} from './document';
import {
  createImageDataUrl,
  formatBytes,
  getImageMimeTypeForPath,
  isTextualAttachment,
  normalizeMimeType,
  normalizeStoredAssetPath,
  resolveAssetFileUri
} from './content';
import {
  resolveEffectiveMessageTemplate,
  resolveEffectiveSystemPrompt,
  resolveTitleGenerationRequestConfig
} from './config';

export async function maybeAutoUpdateChatTitle(
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

export function shouldAutoGenerateChatTitle(currentTitle: string, documentUri: vscode.Uri): boolean {
  const fallbackTitle = trimChatFileSuffix(path.basename(documentUri.fsPath));
  return currentTitle.trim() === DEFAULT_CHAT_TITLE() || currentTitle.trim() === fallbackTitle;
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

export function generateChatTitleFromContent(content: string): string {
  const normalized = normalizeSessionPreviewText(content);
  if (!normalized) {
    return DEFAULT_CHAT_TITLE();
  }

  if (normalized === t('host.imagePlaceholder')) {
    return t('host.imageConversationTitle');
  }

  return truncateSessionPreviewText(normalized, CHAT_TITLE_MAX_LENGTH);
}

export async function generateChatTitleWithAI(
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

export async function generateChatTitleBestEffort(
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

export function createTitleGenerationContext(chat: ChatFile, sourceContent: string): string {
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

export function normalizeGeneratedChatTitle(value: string): string {
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

export async function requestCompletionStreaming(
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

export async function requestGeneratedChatTitle(config: ResolvedModelConfig, prompt: string): Promise<string> {
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

export function extractChatCompletionText(response: unknown): string {
  if (typeof response === 'string') {
    return extractChatCompletionTextFromRawString(response);
  }

  if (!isObject(response)) {
    return '';
  }

  return extractChatCompletionTextFromObject(response);
}

export function extractChatCompletionTextFromObject(response: Record<string, unknown>): string {
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

export function extractChatCompletionTextFromRawString(value: string): string {
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

export function extractSseDataPayloads(value: string): string[] {
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

export function extractTextFromPossibleJson(value: string): string {
  const parsed = tryParseJsonString(value);
  if (parsed !== undefined) {
    return extractChatCompletionText(parsed);
  }

  return value;
}

export function tryParseJsonString(value: string): unknown {
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

export async function streamDirectOpenAI(
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

export interface StreamingChunk {
  model?: string;
  usage?: unknown;
  choices?: Array<{ delta?: Record<string, unknown> }>;
}

export class RequestCanceledError extends Error {
  partialContent: string;
  partialReasoning: string;

  constructor(partialContent: string, partialReasoning: string) {
    super('request canceled');
    this.name = 'RequestCanceledError';
    this.partialContent = partialContent;
    this.partialReasoning = partialReasoning;
  }
}

export function isRequestCanceledError(error: unknown): error is RequestCanceledError {
  return error instanceof RequestCanceledError;
}

export async function createChatCompletionStream(
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

export function extractTextDelta(delta: Record<string, unknown>): string {
  const messageContent = isObject(delta.message) ? delta.message.content : undefined;
  return extractStructuredText(delta.content ?? delta.text ?? messageContent ?? delta.output_text);
}

export function extractReasoningDelta(delta: Record<string, unknown>): string {
  return extractStructuredText(
    delta.reasoning_content ??
      delta.reasoning ??
      delta.reasoningContent ??
      delta.thinking ??
      delta.thinking_content ??
      delta.thinkingContent
  );
}

export function extractStructuredText(value: unknown): string {
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

export function extractStructuredImageMarkdown(value: Record<string, unknown>): string {
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

export function extractStructuredImageUrl(value: Record<string, unknown>): string | undefined {
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

export function normalizeUsageTokenStats(raw: unknown): ChatTokenStats | undefined {
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

export function createStreamOptionsWithUsage(raw: unknown): Record<string, unknown> {
  if (!isObject(raw)) {
    return { include_usage: true };
  }

  return {
    ...raw,
    include_usage: true
  };
}

export interface TemplateContext {
  date: string;
  time: string;
  datetime: string;
  modelId: string;
  modelName: string;
}

export const MESSAGE_TEMPLATE_VARIABLES: Array<{
  name: string;
  resolve: (context: TemplateContext) => string;
}> = [
  { name: 'date', resolve: (ctx) => ctx.date },
  { name: 'time', resolve: (ctx) => ctx.time },
  { name: 'datetime', resolve: (ctx) => ctx.datetime },
  { name: 'model_id', resolve: (ctx) => ctx.modelId },
  { name: 'model_name', resolve: (ctx) => ctx.modelName }
];

export function buildTemplateContext(config: ResolvedModelConfig): TemplateContext {
  const now = new Date();

  return {
    date: now.toLocaleDateString('zh-CN'),
    time: now.toLocaleTimeString('zh-CN'),
    datetime: now.toLocaleString('zh-CN'),
    modelId: config.model,
    modelName: config.modelLabel
  };
}

export function applyTemplateVariables(template: string, context: TemplateContext): string {
  let result = template;

  for (const variable of MESSAGE_TEMPLATE_VARIABLES) {
    result = replaceTemplateToken(result, variable.name, variable.resolve(context));
  }

  return result;
}

export function applyMessageTemplate(template: string, messageContent: string, context: TemplateContext): string {
  return replaceTemplateToken(applyTemplateVariables(template, context), 'message', messageContent);
}

export function appendModelTextContentPart(parts: Array<Record<string, unknown>>, text: string): void {
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

export function appendModelContentParts(
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

export function applyMessageTemplateToModelContent(
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

export async function createModelRequestMessages(
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

export async function createModelMessageContent(
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

export async function createModelTextForFileAttachment(attachment: ChatAttachment, bytes: Uint8Array): Promise<string> {
  return createModelTextForParsedFileAttachment({
    attachment,
    bytes,
    formatBytes,
    isTextualAttachment,
    decodeUtf8,
    t
  });
}

export function getMessagesForModel(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (message) => message.status !== 'pending' && message.status !== 'error' && message.status !== 'canceled'
  );
}
