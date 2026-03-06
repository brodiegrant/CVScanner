import crypto from 'node:crypto';
import { z } from 'zod';

export const HASH_ALGORITHM = 'sha256' as const;

export const ArtifactOriginSchema = z.object({
  filename: z.string(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  gmailAttachmentId: z.string().optional()
});

export const ArtifactProvenanceSchema = z.object({
  artifactId: z.string(),
  sha256: z.string(),
  hashAlgorithm: z.literal(HASH_ALGORITHM),
  origin: ArtifactOriginSchema
});

export const MessageProvenanceSchema = z.object({
  runId: z.string(),
  accountEmail: z.string(),
  label: z.string(),
  messageId: z.string(),
  threadId: z.string().optional(),
  internalDate: z.number().int().nonnegative(),
  ingestionTimestamp: z.string(),
  ingestionTimezone: z.string()
});

export const ExtractionProvenanceSchema = z.object({
  extractorName: z.string(),
  extractorVersion: z.string(),
  extractionTimestamp: z.string(),
  extractionTimezone: z.string()
});

export const ProvenanceSchema = z.object({
  message: MessageProvenanceSchema,
  preExtractionArtifacts: z.array(ArtifactProvenanceSchema),
  postExtractionArtifacts: z.array(ArtifactProvenanceSchema),
  extraction: ExtractionProvenanceSchema.optional()
});

export type ArtifactOrigin = z.infer<typeof ArtifactOriginSchema>;
export type ArtifactProvenance = z.infer<typeof ArtifactProvenanceSchema>;
export type ExtractionProvenance = z.infer<typeof ExtractionProvenanceSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;

export function computeSha256(content: Buffer | string): string {
  return crypto.createHash(HASH_ALGORITHM).update(content).digest('hex');
}

function systemTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function buildIngestProvenance(input: {
  runId: string;
  accountEmail: string;
  label: string;
  messageId: string;
  threadId?: string;
  internalDate: number;
  screeningSourceText?: string;
  attachments: { filename: string; mimeType?: string; size?: number; attachmentId?: string; data?: Buffer }[];
  ingestionTimestamp?: string;
  ingestionTimezone?: string;
}): Provenance {
  const preExtractionArtifacts: ArtifactProvenance[] = [];

  if (input.screeningSourceText) {
    preExtractionArtifacts.push({
      artifactId: 'message-body',
      sha256: computeSha256(input.screeningSourceText),
      hashAlgorithm: HASH_ALGORITHM,
      origin: {
        filename: 'message-body.txt',
        mimeType: 'text/plain',
        size: Buffer.byteLength(input.screeningSourceText, 'utf8')
      }
    });
  }

  for (const attachment of input.attachments) {
    const hashSource = attachment.data
      ? attachment.data
      : `${attachment.filename}|${attachment.mimeType ?? ''}|${attachment.size ?? 0}|${attachment.attachmentId ?? ''}`;

    preExtractionArtifacts.push({
      artifactId: `attachment:${attachment.attachmentId ?? attachment.filename}`,
      sha256: computeSha256(hashSource),
      hashAlgorithm: HASH_ALGORITHM,
      origin: {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        gmailAttachmentId: attachment.attachmentId
      }
    });
  }

  return {
    message: {
      runId: input.runId,
      accountEmail: input.accountEmail,
      label: input.label,
      messageId: input.messageId,
      threadId: input.threadId,
      internalDate: input.internalDate,
      ingestionTimestamp: input.ingestionTimestamp ?? new Date().toISOString(),
      ingestionTimezone: input.ingestionTimezone ?? systemTimezone()
    },
    preExtractionArtifacts,
    postExtractionArtifacts: []
  };
}

export function applyExtractionProvenance(input: {
  provenance: Provenance;
  extractorName: string;
  extractorVersion: string;
  postExtractionArtifacts: { artifactId: string; content: Buffer | string; origin: ArtifactOrigin }[];
  extractionTimestamp?: string;
  extractionTimezone?: string;
}): Provenance {
  return {
    ...input.provenance,
    extraction: {
      extractorName: input.extractorName,
      extractorVersion: input.extractorVersion,
      extractionTimestamp: input.extractionTimestamp ?? new Date().toISOString(),
      extractionTimezone: input.extractionTimezone ?? systemTimezone()
    },
    postExtractionArtifacts: input.postExtractionArtifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      sha256: computeSha256(artifact.content),
      hashAlgorithm: HASH_ALGORITHM,
      origin: artifact.origin
    }))
  };
}

export function withFinalCleaningOutput<T>(cleaned: T, provenance: Provenance): T & { provenance: Provenance } {
  return { ...cleaned, provenance };
}
