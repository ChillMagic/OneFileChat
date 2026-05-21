import type { FileParser, FileParserContext, FileParserResult } from './types';

function buildHeader(context: FileParserContext): string {
  const { attachment, bytes, formatBytes, t } = context;
  return t('host.attachmentHeader', {
    name: attachment.originalName,
    mime: attachment.mimeType,
    size: formatBytes(bytes.byteLength)
  });
}

function buildInlineTextNote(context: FileParserContext, inlineText: string): string {
  const { t } = context;
  return [
    t('host.attachmentTextInlineNote', { header: buildHeader(context) }),
    inlineText
  ].join('\n\n');
}

export const plainTextFileParser: FileParser = {
  async canParse(context: FileParserContext): Promise<boolean> {
    return context.isTextualAttachment(context.attachment, context.bytes);
  },

  async parse(context: FileParserContext): Promise<FileParserResult> {
    const sourceText = context.decodeUtf8(context.bytes).replace(/\r\n?/gu, '\n');

    return {
      text: buildInlineTextNote(context, sourceText)
    };
  }
};