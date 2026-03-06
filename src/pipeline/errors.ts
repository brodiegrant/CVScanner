export type PipelineErrorStage = 'ingest' | 'cleaning' | 'attachment' | 'body_extraction' | (string & {});

type PipelineErrorBase<K extends string> = {
  kind: K;
  stage: PipelineErrorStage;
  message: string;
  messageId: string;
  attachmentId?: string;
  cause?: unknown;
};

export type AttachmentTooLargeError = PipelineErrorBase<'AttachmentTooLargeError'> & {
  maxBytes: number;
  actualBytes: number;
};

export type UnsupportedMimeError = PipelineErrorBase<'UnsupportedMimeError'> & {
  mimeType: string;
};

export type ExtractionFailedError = PipelineErrorBase<'ExtractionFailedError'> & {
  reason?: string;
};

export type ArchiveBombSuspectedError = PipelineErrorBase<'ArchiveBombSuspectedError'> & {
  expansionRatio?: number;
};

export type BodyMissingError = PipelineErrorBase<'BodyMissingError'>;

export type PipelineError =
  | AttachmentTooLargeError
  | UnsupportedMimeError
  | ExtractionFailedError
  | ArchiveBombSuspectedError
  | BodyMissingError;
