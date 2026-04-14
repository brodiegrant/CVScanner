import { createLogger, redact } from '../observability/logger.js';
import { VincereClient } from './client.js';
import { CandidateIdentity, CandidateMatchInput, matchCandidates } from './matching.js';

export type VincereSyncAttachment = {
  attachmentId?: string;
  filename: string;
  mimeType?: string;
  size?: number;
  data?: Buffer;
  rejected?: boolean;
};

export type VincereSyncCandidatePayload = CandidateMatchInput & {
  id?: string;
  functionalExpertiseIds?: string[];
  [key: string]: unknown;
};

export type ManualReviewItem = {
  sourceId: string;
  payload: VincereSyncCandidatePayload;
  matches: ReturnType<typeof matchCandidates>;
  createdAt: string;
};

export interface ManualReviewQueue {
  enqueue(item: ManualReviewItem): Promise<void>;
}

export type SyncResult =
  | { disposition: 'updated'; candidateId: string }
  | { disposition: 'created'; candidateId: string }
  | { disposition: 'manual_review'; reason: string };

export async function syncCandidateToVincere(opts: {
  sourceId: string;
  payload: VincereSyncCandidatePayload;
  existingCandidates: CandidateIdentity[];
  attachments?: VincereSyncAttachment[];
  vincereClient: VincereClient;
  reviewQueue: ManualReviewQueue;
  dryRun?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}): Promise<SyncResult> {
  const logger = createLogger(opts.logLevel ?? 'info');

  let emailLookupCandidateId: string | null = null;
  const email = opts.payload.email?.trim();
  if (email) {
    const emailCandidate = await opts.vincereClient.findCandidateByEmail(email);
    emailLookupCandidateId = emailCandidate?.id ?? null;
  }

  const matches = matchCandidates(opts.payload, opts.existingCandidates);
  const plausible = matches.filter((m) => m.confidence !== 'low');

  if (emailLookupCandidateId) {
    return await updateCandidateAndIngestAttachments({
      logger,
      candidateId: emailLookupCandidateId,
      sourceId: opts.sourceId,
      payload: opts.payload,
      attachments: opts.attachments,
      vincereClient: opts.vincereClient,
      dryRun: opts.dryRun,
      strategy: 'api_email_lookup',
      score: 100
    });
  }

  if (plausible.length === 1 && plausible[0]) {
    return await updateCandidateAndIngestAttachments({
      logger,
      candidateId: plausible[0].candidateId,
      sourceId: opts.sourceId,
      payload: opts.payload,
      attachments: opts.attachments,
      vincereClient: opts.vincereClient,
      dryRun: opts.dryRun,
      strategy: plausible[0].strategy,
      score: plausible[0].score
    });
  }

  if (plausible.length === 0) {
    const path = '/api/candidate';
    logger.info('vincere.write.create_candidate', {
      sourceId: opts.sourceId,
      dryRun: Boolean(opts.dryRun),
      payload: redact(opts.payload)
    });

    const createdCandidateId = opts.dryRun
      ? 'dry-run'
      : (await opts.vincereClient.post<{ id: string }>(path, opts.payload)).id;

    await applyPostSyncCandidateActions({
      logger,
      candidateId: createdCandidateId,
      sourceId: opts.sourceId,
      payload: opts.payload,
      attachments: opts.attachments,
      vincereClient: opts.vincereClient,
      dryRun: opts.dryRun
    });

    return { disposition: 'created', candidateId: createdCandidateId };
  }

  await opts.reviewQueue.enqueue({
    sourceId: opts.sourceId,
    payload: opts.payload,
    matches: plausible,
    createdAt: new Date().toISOString()
  });
  logger.warn('vincere.manual_review.enqueued', {
    sourceId: opts.sourceId,
    plausibleMatches: plausible.map((m) => ({ candidateId: m.candidateId, score: m.score, strategy: m.strategy }))
  });

  return { disposition: 'manual_review', reason: 'multiple_plausible_matches' };
}

async function updateCandidateAndIngestAttachments(opts: {
  logger: ReturnType<typeof createLogger>;
  candidateId: string;
  sourceId: string;
  payload: VincereSyncCandidatePayload;
  attachments?: VincereSyncAttachment[];
  vincereClient: VincereClient;
  dryRun?: boolean;
  strategy: string;
  score: number;
}): Promise<SyncResult> {
  const path = `/api/candidate/${encodeURIComponent(opts.candidateId)}`;
  opts.logger.info('vincere.write.update_candidate', {
    sourceId: opts.sourceId,
    candidateId: opts.candidateId,
    dryRun: Boolean(opts.dryRun),
    strategy: opts.strategy,
    score: opts.score,
    payload: redact(opts.payload)
  });

  if (!opts.dryRun) {
    await opts.vincereClient.patch(path, opts.payload);
  }

  await applyPostSyncCandidateActions({
    logger: opts.logger,
    candidateId: opts.candidateId,
    sourceId: opts.sourceId,
    payload: opts.payload,
    attachments: opts.attachments,
    vincereClient: opts.vincereClient,
    dryRun: opts.dryRun
  });

  return { disposition: 'updated', candidateId: opts.candidateId };
}

async function applyPostSyncCandidateActions(opts: {
  logger: ReturnType<typeof createLogger>;
  candidateId: string;
  sourceId: string;
  payload: VincereSyncCandidatePayload;
  attachments?: VincereSyncAttachment[];
  vincereClient: VincereClient;
  dryRun?: boolean;
}): Promise<void> {
  const functionalExpertiseIds = opts.payload.functionalExpertiseIds ?? [];
  if (functionalExpertiseIds.length > 0) {
    opts.logger.info('vincere.write.update_functional_expertise', {
      sourceId: opts.sourceId,
      candidateId: opts.candidateId,
      dryRun: Boolean(opts.dryRun),
      functionalExpertiseCount: functionalExpertiseIds.length
    });

    if (!opts.dryRun) {
      await opts.vincereClient.updateFunctionalExpertiseLinks(opts.candidateId, functionalExpertiseIds);
    }
  }

  const selectedCv = selectCvAttachment(opts.attachments ?? []);
  if (!selectedCv) return;

  opts.logger.info('vincere.write.upload_candidate_document', {
    sourceId: opts.sourceId,
    candidateId: opts.candidateId,
    dryRun: Boolean(opts.dryRun),
    filename: selectedCv.filename,
    mimeType: selectedCv.mimeType,
    size: selectedCv.size
  });

  if (!opts.dryRun) {
    await opts.vincereClient.uploadCandidateDocument(opts.candidateId, {
      filename: selectedCv.filename,
      mimeType: selectedCv.mimeType,
      data: selectedCv.data
    });
  }
}

function selectCvAttachment(attachments: VincereSyncAttachment[]): (VincereSyncAttachment & { data: Buffer }) | null {
  const accepted = attachments
    .filter((attachment): attachment is VincereSyncAttachment & { data: Buffer } => Boolean(attachment.data?.length) && !attachment.rejected)
    .filter((attachment) => isSupportedDocument(attachment.filename, attachment.mimeType));

  if (accepted.length === 0) return null;

  const sorted = [...accepted].sort((a, b) => scoreAttachment(b) - scoreAttachment(a));
  return sorted[0] ?? null;
}

function isSupportedDocument(filename: string, mimeType?: string): boolean {
  const normalizedMime = (mimeType ?? '').toLowerCase();
  const lowerName = filename.toLowerCase();
  const extension = lowerName.includes('.') ? lowerName.slice(lowerName.lastIndexOf('.') + 1) : '';

  const allowedExtensions = new Set(['pdf', 'doc', 'docx']);
  const allowedMimeTypes = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]);

  return allowedExtensions.has(extension) || allowedMimeTypes.has(normalizedMime);
}

function scoreAttachment(attachment: VincereSyncAttachment): number {
  const file = attachment.filename.toLowerCase();
  let score = 0;

  if (file.includes('cv')) score += 50;
  if (file.includes('resume')) score += 50;

  if (file.endsWith('.pdf')) score += 20;
  if (file.endsWith('.docx')) score += 10;
  if (file.endsWith('.doc')) score += 5;

  score += Math.min(Math.floor((attachment.size ?? 0) / 1024), 20);
  return score;
}
