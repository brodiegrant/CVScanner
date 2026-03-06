import crypto from 'node:crypto';
import { AppConfig } from '../../config/config.js';
import { AttachmentRejectReason, GmailClient } from '../client/gmailClient.js';
import { CursorStore } from '../../storage/cursorStore.js';
import { createLogger } from '../../observability/logger.js';
import { Metrics } from '../../observability/metrics.js';
import { PipelineError } from '../../pipeline/errors.js';

const CURSOR_OVERLAP_MS = 1000;

export type IngestForLlm = {
  runId: string;
  accountEmail: string;
  label: string;
  messageId: string;
  threadId?: string;
  internalDate: number;
  from?: string;
  to?: string;
  subject?: string;
  snippet?: string;
  rawBodyCandidate?: string;
  normalizedBodyCandidate?: string;
  bodyExtractionSource?: 'text/plain' | 'text/html-fallback';
  screeningSourceText?: string;
  bodyCharCount?: number;
  bodyTruncated?: boolean;
  contentHash?: string;
  attachments: { filename: string; mimeType?: string; size?: number; data?: Buffer; rejected: boolean; rejectReason?: AttachmentRejectReason }[];
  sensitivity: 'contains_pii';
};

export type RunSummary = {
  runId: string;
  startTimestamp: string;
  endTimestamp: string;
  accountEmail: string;
  label: string;
  counts: {
    found: number;
    new: number;
    processed: number;
    skipped: number;
    attachments_found: number;
    attachments_downloaded: number;
  };
  processed_message_ids: string[];
  attachment_filenames: string[];
  attachment_sizes: number[];
  attachment_reject_reasons: { filename: string; reason: AttachmentRejectReason }[];
  errors: { code: string; message: string; stage: string }[];
};

export async function ingestOnce(opts: {
  accountEmail: string;
  label?: string;
  dryRun?: boolean;
  config: AppConfig;
  gmailClient: GmailClient;
  cursorStore: CursorStore;
  metrics: Metrics;
  onMessage: (m: IngestForLlm) => Promise<void>;
}): Promise<RunSummary> {
  const logger = createLogger(opts.config.logLevel);
  const runId = crypto.randomUUID();
  const start = new Date();
  const label = opts.label ?? opts.config.defaultLabel;
  const errors: RunSummary['errors'] = [];
  const overlapMs = 1000;
  const processed_message_ids: string[] = [];
  const attachment_filenames: string[] = [];
  const attachment_sizes: number[] = [];
  const attachment_reject_reasons: { filename: string; reason: AttachmentRejectReason }[] = [];
  let found = 0, newlyFound = 0, processed = 0, skipped = 0, attachmentsFound = 0, attachmentsDownloaded = 0;

  try {
    const cursor = opts.cursorStore.getCursor(opts.accountEmail, label);
    const since = cursor?.lastSuccessInternalDate ?? 0;
    // Query with a bounded overlap to guard against second-level `after:`
    // boundaries and equal internalDate timestamps; processed_messages dedupe
    // is the correctness guard that prevents double-processing.
    const queryAfter = Math.max(0, since - overlapMs);
    const ids = await opts.gmailClient.listMessageIds(label, queryAfter);
    found = ids.length;

    const messages = await Promise.all(ids.map((id) => opts.gmailClient.getMessageMetadata(id, opts.config.ingestIncludeBody, opts.config.ingestBodyMaxChars)));
    messages.sort((a, b) => a.internalDate - b.internalDate);

    for (const m of messages) {
      if (opts.cursorStore.isProcessed(opts.accountEmail, label, m.messageId, opts.config.dedupeLookbackDays)) {
        skipped++;
        continue;
      }
      newlyFound++;
      const atts = await opts.gmailClient.getAttachments(m.messageId, {
        maxBytes: opts.config.maxAttachmentBytes,
        allowedMimeTypes: opts.config.allowedAttachmentMimeTypes,
        allowedExtensions: opts.config.allowedAttachmentExtensions,
        allowArchives: opts.config.allowAttachmentArchives,
        maxArchiveExpansionRatio: opts.config.maxArchiveExpansionRatio
      }, !opts.dryRun);
      attachmentsFound += atts.length;
      if (!opts.dryRun) {
        attachmentsDownloaded += atts.reduce((total, att) => total + (att.data?.length ?? 0), 0);
      }
      atts.forEach((a) => {
        attachment_filenames.push(a.filename);
        attachment_sizes.push(a.size ?? 0);
        if (a.rejectReason) attachment_reject_reasons.push({ filename: a.filename, reason: a.rejectReason });
      });

      const payload: IngestForLlm = {
        runId,
        accountEmail: opts.accountEmail,
        label,
        messageId: m.messageId,
        threadId: m.threadId,
        internalDate: m.internalDate,
        from: m.from,
        to: m.to,
        subject: m.subject,
        snippet: m.snippet,
        rawBodyCandidate: m.rawBodyCandidate,
        normalizedBodyCandidate: m.normalizedBodyCandidate,
        bodyExtractionSource: m.bodyExtractionSource,
        screeningSourceText: m.normalizedBodyCandidate,
        bodyCharCount: m.bodyCharCount,
        bodyTruncated: m.bodyTruncated,
        contentHash: m.normalizedBodyCandidate ? crypto.createHash('sha256').update(m.normalizedBodyCandidate).digest('hex') : undefined,
        attachments: atts.map((a) => ({ filename: a.filename, mimeType: a.mimeType, size: a.size, data: a.data })),
        sensitivity: 'contains_pii'
      };

      await opts.onMessage(payload);
      opts.cursorStore.markProcessed(opts.accountEmail, label, m.messageId, m.internalDate);
      // Cursor only advances on successful handling. With overlap queries above,
      // this lets failed same-timestamp neighbors be retried on the next run
      // while dedupe prevents reprocessing of already-successful messages.
      opts.cursorStore.setCursor(opts.accountEmail, label, m.internalDate);
      processed_message_ids.push(m.messageId);
      processed++;
    }

    opts.cursorStore.pruneProcessed(opts.accountEmail, label, opts.config.dedupeLookbackDays);
    opts.metrics.increment('ingest_run_completed', 1, { runId, accountEmail: opts.accountEmail, label, processed });
  } catch (err) {
    const cause = err instanceof Error ? err : undefined;
    const message = cause?.message ?? 'Unknown fatal error';
    errors.push({
      kind: 'ExtractionFailedError',
      stage: 'ingest',
      message,
      messageId: '__run__',
      reason: message,
      cause
    });
    logger.error('Ingest fatal error', { runId, accountEmail: opts.accountEmail, label, error: message });
    opts.metrics.increment('ingest_run_failed', 1, { runId, stage: 'ingest', code: 'ExtractionFailedError' });
  }

  return {
    runId,
    startTimestamp: start.toISOString(),
    endTimestamp: new Date().toISOString(),
    accountEmail: opts.accountEmail,
    label,
    counts: { found, new: newlyFound, processed, skipped, attachments_found: attachmentsFound, attachments_downloaded: attachmentsDownloaded },
    processed_message_ids,
    attachment_filenames,
    attachment_sizes,
    attachment_reject_reasons,
    errors
  };
}
