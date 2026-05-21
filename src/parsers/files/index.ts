import { plainTextFileParser } from './plainText';
import type { FileParserContext } from './types';

const fileParsers = [plainTextFileParser];

export async function createModelTextForParsedFileAttachment(
  context: FileParserContext
): Promise<string> {
  for (const parser of fileParsers) {
    if (await parser.canParse(context)) {
      return (await parser.parse(context)).text;
    }
  }

  return context.t('host.attachmentBinaryNote', {
    header: context.t('host.attachmentHeader', {
      name: context.attachment.originalName,
      mime: context.attachment.mimeType,
      size: context.formatBytes(context.bytes.byteLength)
    })
  });
}

export type { FileParserContext, FileParserResult } from './types';