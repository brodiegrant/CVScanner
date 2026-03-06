import crypto from 'node:crypto';
import { AppConfig } from '../../config/config.js';
import { GmailClient } from '../client/gmailClient.js';
import { CursorStore } from '../../storage/cursorStore.js';
import { createLogger } from '../../observability/logger.js';
import { Metrics } from '../../observability/metrics.js';

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
  screeningSourceText?: string;
  bodyCharCount?: number;
  bodyTruncated?: boolean;
  contentHash?: string;
  attachments: { filename: string; mimeType?: string; size?: number; data?: Buffer }[];
  sensitivity: 'contains_pii';
};

export type RunSummary = {
  runId: string;
  startTimestamp: string;
  endTimestamp: string;
  accountEmail: string;
  label: string;
  counts: { found: number; new: number; processed: number; skipped: number; attachments_downloaded: number };
  processed_message_ids: string[];
  attachment_filenames: string[];
  attachment_sizes: number[];
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
  const processed_message_ids: string[] = [];
  const attachment_filenames: string[] = [];
  const attachment_sizes: number[] = [];
  let found = 0, newlyFound = 0, processed = 0, skipped = 0, attachmentsDownloaded = 0;

  try {
    const cursor = opts.cursorStore.getCursor(opts.accountEmail, label);
    const since = cursor?.lastSuccessInternalDate ?? 0;
    const querySince = Math.max(0, since - CURSOR_OVERLAP_MS);
    const ids = await opts.gmailClient.listMessageIds(label, querySince);
    found = ids.length;

    const messages = await Promise.all(ids.map((id) => opts.gmailClient.getMessageMetadata(id, opts.config.ingestIncludeBody, opts.config.ingestBodyMaxChars)));
    messages.sort((a, b) => a.internalDate - b.internalDate);

    for (const m of messages) {
      if (opts.cursorStore.isProcessed(opts.accountEmail, label, m.messageId, opts.config.dedupeLookbackDays)) {
        skipped++;
        continue;
      }
      newlyFound++;
      const atts = await opts.gmailClient.getAttachments(m.messageId, opts.config.allowedAttachmentExtensions, !opts.dryRun);
      attachmentsDownloaded += atts.length;
      atts.forEach((a) => {
        attachment_filenames.push(a.filename);
        attachment_sizes.push(a.size ?? 0);
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
        screeningSourceText: m.bodyText,
        bodyCharCount: m.bodyCharCount,
        bodyTruncated: m.bodyTruncated,
        contentHash: m.bodyText ? crypto.createHash('sha256').update(m.bodyText).digest('hex') : undefined,
        attachments: atts.map((a) => ({ filename: a.filename, mimeType: a.mimeType, size: a.size, data: a.data })),
        sensitivity: 'contains_pii'
      };

      await opts.onMessage(payload);
      opts.cursorStore.markProcessed(opts.accountEmail, label, m.messageId, m.internalDate);
      opts.cursorStore.setCursor(opts.accountEmail, label, m.internalDate);
      processed_message_ids.push(m.messageId);
      processed++;
    }

    opts.cursorStore.pruneProcessed(opts.accountEmail, label, opts.config.dedupeLookbackDays);
    opts.metrics.increment('ingest_run_completed', 1, { runId, accountEmail: opts.accountEmail, label, processed });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown fatal error';
    errors.push({ code: 'FATAL_INGEST', message, stage: 'ingest' });
    logger.error('Ingest fatal error', { runId, accountEmail: opts.accountEmail, label, error: message });
    opts.metrics.increment('ingest_run_failed', 1, { runId, stage: 'ingest', code: 'FATAL_INGEST' });
  }

  return {
    runId,
    startTimestamp: start.toISOString(),
    endTimestamp: new Date().toISOString(),
    accountEmail: opts.accountEmail,
    label,
    counts: { found, new: newlyFound, processed, skipped, attachments_downloaded: attachmentsDownloaded },
    processed_message_ids,
    attachment_filenames,
    attachment_sizes,
    errors
  };
}
