import {
  type ChatAttachment,
  type ChatMessage,
  type ChatMessageBody,
  type ChatMessageVersion,
  type ChatModelSelection,
  type WebviewChatContentPart,
  type WebviewProviderItem
} from '../shared/protocol';
import { t } from '../shared/i18n';
import { state } from './store';

export const MESSAGE_PREVIEW_MAX_LENGTH = 92;
export const ACCEPTED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]);

export function formatTime(value: string | number | Date | undefined): string {
  if (value == null) return '';
  const d = new Date(value as any);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

export function formatBytes(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  const rounded = i === 0 ? String(size) : size.toFixed(size >= 10 ? 0 : 1);
  return `${rounded} ${units[i]}`;
}

export function formatDuration(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 10000) return `${(value / 1000).toFixed(1)} s`;
  if (value < 60000) return `${Math.round(value / 1000)} s`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return seconds === 0
    ? t('utils.durationMinutes', { minutes })
    : t('utils.durationMinSec', { minutes, seconds });
}

export function formatTokenCount(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '';
  return new Intl.NumberFormat().format(Math.trunc(value));
}

export function normalizePreviewText(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function truncatePreview(value: string): string {
  if (value.length <= MESSAGE_PREVIEW_MAX_LENGTH) return value;
  return `${value.slice(0, MESSAGE_PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
}

export function getMessageVersions(m: ChatMessage): ChatMessageVersion[] {
  return Array.isArray(m.versions) ? m.versions : [];
}

export function getCurrentVersion(m: ChatMessage): ChatMessageVersion | null {
  const vs = getMessageVersions(m);
  if (vs.length === 0) return null;
  if (m.currentVersionId) {
    const f = vs.find((v) => v.id === m.currentVersionId);
    if (f) return f;
  }
  return vs[vs.length - 1] || null;
}

export function isCurrentVersion(m: ChatMessage, versionId: string): boolean {
  return getCurrentVersion(m)?.id === versionId;
}

export function getCurrentContent(m: ChatMessage): string {
  const cv = getCurrentVersion(m);
  if (typeof cv?.content === 'string' && cv.content.length > 0) return cv.content;
  return typeof m.content === 'string' ? m.content : '';
}

export function getDisplayedVersion(m: ChatMessage): ChatMessageVersion | null {
  const pid = state.previewVersionId[m.id];
  if (pid) {
    const found = getMessageVersions(m).find((v) => v.id === pid);
    if (found) return found;
  }
  return getCurrentVersion(m);
}

export function getVisibleContent(m: ChatMessage, version: ChatMessageVersion | null = null): string {
  if (typeof version?.content === 'string' && version.content.trim()) return version.content;
  const cc = getCurrentContent(m);
  if (cc.trim()) return cc;
  if (m.role === 'assistant' && m.status === 'pending') return t('messages.pendingFallback');
  if (m.role === 'assistant' && m.status === 'canceled') return t('messages.canceledFallback');
  if (m.role === 'assistant' && m.status === 'error') return m.errorDetail?.trim() || t('messages.errorFallback');
  return '';
}

export function getDisplayedContent(m: ChatMessage): string {
  return getVisibleContent(m, getDisplayedVersion(m));
}

function sanitizeMarkdownLabel(value: string): string {
  return String(value || '').replace(/[\r\n\[\]]+/g, ' ').replace(/\s+/g, ' ').trim() || 'attachment';
}

function basenameFromPath(p: string): string {
  if (!p) return '';
  const cleaned = String(p).replace(/\\/g, '/');
  const idx = cleaned.lastIndexOf('/');
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

export function buildMarkdownFromBody(
  body: ChatMessageBody | undefined,
  attachments: ChatAttachment[] | undefined
): string {
  if (!body || !Array.isArray(body.parts) || body.parts.length === 0) return '';
  const map = new Map((attachments ?? []).map((a) => [a.id, a]));
  const out: string[] = [];
  for (const part of body.parts) {
    if (part.type === 'text') {
      out.push(part.text);
      continue;
    }
    const att = map.get(part.attachmentId);
    if (!att) {
      out.push(t('messages.attachmentLost'));
      continue;
    }
    const label = sanitizeMarkdownLabel(att.originalName || basenameFromPath(att.assetPath));
    const dest = att.assetPath;
    out.push(att.kind === 'image' ? `![${label}](${dest})` : `[${label}](${dest})`);
  }
  return out.join('');
}

export function getEditableMarkdownContent(m: ChatMessage): string {
  const dv = getDisplayedVersion(m);
  const body = dv?.body ?? m.body;
  const attachments =
    (dv?.attachments && dv.attachments.length > 0 ? dv.attachments : m.attachments) ?? [];
  const md = buildMarkdownFromBody(body, attachments);
  if (md) return md;
  // fall back to plain content (assistant messages, etc.)
  return getDisplayedContent(m);
}

export function getDisplayedContentHtml(m: ChatMessage): string | undefined {
  const dv = getDisplayedVersion(m);
  if (typeof dv?.contentHtml === 'string' && dv.contentHtml.trim()) return dv.contentHtml;
  if (typeof m.contentHtml === 'string' && m.contentHtml.trim()) return m.contentHtml;
  return undefined;
}

export function getDisplayedReasoningText(m: ChatMessage): string {
  const dv = getDisplayedVersion(m);
  if (typeof dv?.reasoningContent === 'string' && dv.reasoningContent.trim()) return dv.reasoningContent;
  if (typeof m.reasoningContent === 'string' && m.reasoningContent.trim()) return m.reasoningContent;
  return '';
}

export function getDisplayedReasoningHtml(m: ChatMessage): string | undefined {
  const dv = getDisplayedVersion(m);
  if (typeof dv?.reasoningContentHtml === 'string' && dv.reasoningContentHtml.trim()) return dv.reasoningContentHtml;
  if (typeof m.reasoningContentHtml === 'string' && m.reasoningContentHtml.trim()) return m.reasoningContentHtml;
  return undefined;
}

export function getDisplayedTokenStats(m: ChatMessage) {
  const dv = getDisplayedVersion(m);
  if (dv?.tokenStats && typeof dv.tokenStats.totalTokens === 'number') return dv.tokenStats;
  if (m.tokenStats && typeof m.tokenStats.totalTokens === 'number' && m.tokenStats.totalTokens >= 0) return m.tokenStats;
  return null;
}

export function getDisplayedDuration(m: ChatMessage): number | undefined {
  const dv = getDisplayedVersion(m);
  if (typeof dv?.totalDurationMs === 'number' && dv.totalDurationMs >= 0) return dv.totalDurationMs;
  return m.totalDurationMs;
}

export function getDisplayedThinkingDuration(m: ChatMessage): number | undefined {
  const dv = getDisplayedVersion(m);
  if (typeof dv?.thinkingDurationMs === 'number' && dv.thinkingDurationMs >= 0) return dv.thinkingDurationMs;
  return m.thinkingDurationMs;
}

export function getDisplayedContentParts(m: ChatMessage): WebviewChatContentPart[] | null {
  const dv = getDisplayedVersion(m);
  if (Array.isArray(dv?.contentParts) && dv!.contentParts!.length > 0) return dv!.contentParts!;
  if (Array.isArray(m.contentParts) && m.contentParts.length > 0) return m.contentParts;
  return null;
}

export function getMessagePreviewSummary(m: ChatMessage): string {
  const txt = normalizePreviewText(getDisplayedContent(m));
  if (txt) return truncatePreview(txt);
  const vis = normalizePreviewText(getVisibleContent(m));
  if (vis) return truncatePreview(vis);
  const parts = getDisplayedContentParts(m);
  if (Array.isArray(parts) && parts.some((p) => p?.type === 'image')) return t('preview.image');
  return t('preview.empty');
}

export function getRoleLabel(m: ChatMessage): string {
  if (m.role === 'user') return t('messages.roleUser');
  if (m.role === 'assistant') {
    const displayedVersion = getDisplayedVersion(m);
    return (
      (typeof displayedVersion?.assistantLabel === 'string' && displayedVersion.assistantLabel.trim()) ||
      (typeof m.model === 'string' && m.model.trim()) ||
      t('messages.roleAssistant')
    );
  }
  return t('messages.roleSystem');
}

export function getSelectionAssistantLabel(
  providers: WebviewProviderItem[],
  selection: ChatModelSelection | null | undefined
): string | undefined {
  if (!selection?.providerId || !selection.modelId) return undefined;
  const provider = providers.find((p) => p.id === selection.providerId);
  if (!provider) return undefined;
  const model = provider.models.find((m) => m.id === selection.modelId);
  if (!model) return undefined;
  const parts = [model.label];
  if (selection.optionId) {
    const opt = model.options.find((o) => o.id === selection.optionId);
    if (opt) parts.push(opt.label);
  }
  return parts.join(' · ');
}

export function getMessageAnchorId(id: string): string {
  return `message-${id}`;
}

export function canPreviewInlineImage(role: string): boolean {
  return role === 'user' || role === 'assistant';
}

export function getSelectionLabel(
  providers: WebviewProviderItem[],
  selection: ChatModelSelection | null
): string {
  if (!selection?.providerId || !selection.modelId) return t('utils.selectModelDefault');
  const provider = providers.find((p) => p.id === selection.providerId);
  if (!provider) return t('utils.selectModelDefault');
  const model = provider.models.find((m) => m.id === selection.modelId);
  if (!model) return provider.label;
  const parts = [provider.label, model.label];
  if (selection.optionId) {
    const opt = model.options.find((o) => o.id === selection.optionId);
    if (opt) parts.push(opt.label);
  }
  return parts.join(' / ');
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(t('utils.cannotReadAttachment')));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => reject(reader.error || new Error(t('utils.cannotReadAttachment')));
    reader.readAsDataURL(file);
  });
}

export function hasPrimaryModifier(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey;
}

export function isPromptHistoryShortcut(e: KeyboardEvent): boolean {
  if (!hasPrimaryModifier(e) || e.altKey) return false;
  const key = String(e.key || '').toLowerCase();
  return key === 'z' || key === 'y';
}

export function hasLocalMarkdownAssetReference(text: string): boolean {
  return typeof text === 'string' && text.includes('.filechat/assets/') && /!?\[[^\]\r\n]*\]\([^\)\r\n]*\.filechat\/assets\//.test(text);
}

export function getFallbackAttachmentName(file: File, index: number, existingCount: number): string {
  if (typeof file?.name === 'string' && file.name.trim()) return file.name.trim();
  const mimeType = typeof file?.type === 'string' ? file.type.toLowerCase() : '';
  const subtype = mimeType ? mimeType.split('/')[1] : '';
  const normalizedSubtype = subtype.toLowerCase();
  const extension = normalizedSubtype === 'jpeg' ? 'jpg' : normalizedSubtype.replace(/[^a-z0-9]+/g, '') || 'bin';
  const prefix = mimeType.startsWith('image/') ? 'pasted-image' : 'pasted-file';
  return `${prefix}-${existingCount + index + 1}.${extension}`;
}

export interface ReadAttachmentItem {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  kind: 'image' | 'file';
}

export async function readAttachmentsFromFiles(
  files: File[],
  existingCount = 0
): Promise<ReadAttachmentItem[]> {
  const acceptable = files.filter((f) => f instanceof File);
  if (acceptable.length === 0) return [];
  const unsupportedImage = acceptable.find(
    (f) => f.type.toLowerCase().startsWith('image/') && !ACCEPTED_IMAGE_MIME_TYPES.has(f.type.toLowerCase())
  );
  if (unsupportedImage) {
    throw new Error(
      t('utils.unsupportedImageType', {
        type: unsupportedImage.type || unsupportedImage.name || 'unknown'
      })
    );
  }
  return await Promise.all(
    acceptable.map(async (file, index) => {
      const dataUrl = await readFileAsDataUrl(file);
      const mimeType = file.type || 'application/octet-stream';
      const name = getFallbackAttachmentName(file, index, existingCount);
      return {
        id: `att-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        mimeType,
        size: file.size,
        dataUrl,
        kind: (mimeType.toLowerCase().startsWith('image/') ? 'image' : 'file') as 'image' | 'file'
      };
    })
  );
}
