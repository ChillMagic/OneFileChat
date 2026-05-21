import type { ChatAttachment } from '../../shared/protocol';

export interface FileParserContext {
  attachment: ChatAttachment;
  bytes: Uint8Array;
  formatBytes: (value: number) => string;
  isTextualAttachment: (attachment: ChatAttachment, bytes: Uint8Array) => Promise<boolean>;
  decodeUtf8: (bytes: Uint8Array) => string;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export interface FileParserResult {
  text: string;
}

export interface FileParser {
  canParse: (context: FileParserContext) => Promise<boolean>;
  parse: (context: FileParserContext) => Promise<FileParserResult>;
}