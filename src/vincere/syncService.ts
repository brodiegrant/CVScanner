import { createLogger, redact } from '../observability/logger.js';
import { mapTagsToExpertiseLinks } from './expertiseMapping.js';
import { VincereClient } from './client.js';
import { CandidateIdentity, CandidateMatchInput, matchCandidates } from './matching.js';
import type { VincereSyncAttemptRow } from '../storage/sqlite/sqlitePipelineStore.js';

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
  subFunctionalExpertiseIds?: string[];
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

export type VincereSyncAttemptRecorderInput = Omit<
  VincereSyncAttemptRow,
  'candidateIdentifier' | 'matchOutcome' | 'matchedCandidateId' | 'tagsProposed' | 'tagsApplied' | 'resultStatus' | 'errorText'
> & {
  sourceId: string;
  resultStatus: 'success' | 'error' | 'skipped';
  errorText: string | null;
};

export async function syncCandidateToVincere(opts: {
  sourceId: string;
  payload: VincereSyncCandidatePayload;
  existingCandidates: CandidateIdentity[];
  attachments?: VincereSyncAttachment[];
  vincereClient: VincereClient;
  reviewQueue: ManualReviewQueue;
  dryRun?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  recordSyncAttempt?: (attempt: VincereSyncAttemptRecorderInput) => Promise<void> | void;
}): Promise<SyncResult> {
  const logger = createLogger(opts.logLevel ?? 'info');
  const attemptState = createAttemptState(opts.sourceId);

  try {
    const emailLookupCandidateId = await lookupCandidateIdByEmail({
      attemptState,
      payload: opts.payload,
      vincereClient: opts.vincereClient
    });

    const matches = matchCandidates(opts.payload, opts.existingCandidates);
    const plausible = matches.filter((m) => m.confidence !== 'low');

    if (emailLookupCandidateId) {
      const result = await updateCandidateAndIngestAttachments({
        logger,
        attemptState,
        candidateId: emailLookupCandidateId,
        sourceId: opts.sourceId,
        payload: opts.payload,
        attachments: opts.attachments,
        vincereClient: opts.vincereClient,
        dryRun: opts.dryRun,
        strategy: 'api_email_lookup',
        score: 100
      });
      await persistSyncAttempt(opts.recordSyncAttempt, attemptState, 'success', null);
      return result;
    }

    if (plausible.length === 1 && plausible[0]) {
      const result = await updateCandidateAndIngestAttachments({
        logger,
        attemptState,
        candidateId: plausible[0].candidateId,
        sourceId: opts.sourceId,
        payload: opts.payload,
        attachments: opts.attachments,
        vincereClient: opts.vincereClient,
        dryRun: opts.dryRun,
        strategy: plausible[0].strategy,
        score: plausible[0].score
      });
      await persistSyncAttempt(opts.recordSyncAttempt, attemptState, 'success', null);
      return result;
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

      attemptState.candidateUpsertOutcome = JSON.stringify({
        step: 'create_candidate',
        status: 'created',
        candidateId: createdCandidateId
      });
      attemptState.resolvedUploadCandidateId = createdCandidateId;

      await applyPostSyncCandidateActions({
        logger,
        attemptState,
        candidateId: createdCandidateId,
        sourceId: opts.sourceId,
        payload: opts.payload,
        attachments: opts.attachments,
        vincereClient: opts.vincereClient,
        dryRun: opts.dryRun
      });

      await persistSyncAttempt(opts.recordSyncAttempt, attemptState, 'success', null);
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

    attemptState.candidateUpsertOutcome = JSON.stringify({
      step: 'candidate_resolution',
      status: 'manual_review_enqueued',
      reason: 'multiple_plausible_matches'
    });
    await persistSyncAttempt(opts.recordSyncAttempt, attemptState, 'skipped', 'multiple_plausible_matches');
    return { disposition: 'manual_review', reason: 'multiple_plausible_matches' };
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    if (!attemptState.documentUploadErrorText && attemptState.documentUploadResult === 'failed') {
      attemptState.documentUploadErrorText = errorText;
    }
    await persistSyncAttempt(opts.recordSyncAttempt, attemptState, 'error', errorText);
    throw error;
  }
}

async function updateCandidateAndIngestAttachments(opts: {
  logger: ReturnType<typeof createLogger>;
  attemptState: SyncAttemptState;
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
  opts.attemptState.candidateUpsertOutcome = JSON.stringify({
    step: 'update_candidate',
    status: 'updated',
    candidateId: opts.candidateId,
    strategy: opts.strategy
  });
  opts.attemptState.resolvedUploadCandidateId = opts.candidateId;

  await applyPostSyncCandidateActions({
    logger: opts.logger,
    attemptState: opts.attemptState,
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
  attemptState: SyncAttemptState;
  candidateId: string;
  sourceId: string;
  payload: VincereSyncCandidatePayload;
  attachments?: VincereSyncAttachment[];
  vincereClient: VincereClient;
  dryRun?: boolean;
}): Promise<void> {
  const functionalExpertiseIds = dedupeIds(opts.payload.functionalExpertiseIds);
  const subFunctionalExpertiseIds = dedupeIds(opts.payload.subFunctionalExpertiseIds);
  if (functionalExpertiseIds.length > 0 || subFunctionalExpertiseIds.length > 0) {
    opts.attemptState.expertiseLinkPayload = JSON.stringify({
      functionalExpertiseIds,
      subFunctionalExpertiseIds
    });

    opts.logger.info('vincere.write.update_functional_expertise', {
      sourceId: opts.sourceId,
      candidateId: opts.candidateId,
      dryRun: Boolean(opts.dryRun),
      functionalExpertiseCount: functionalExpertiseIds.length,
      subFunctionalExpertiseCount: subFunctionalExpertiseIds.length
    });

    try {
      if (!opts.dryRun) {
        await opts.vincereClient.updateFunctionalExpertiseLinks(opts.candidateId, functionalExpertiseIds);
        await opts.vincereClient.updateSubFunctionalExpertiseLinks(opts.candidateId, subFunctionalExpertiseIds);
      }
      opts.attemptState.expertiseLinkResult = 'linked';
    } catch (error) {
      opts.attemptState.expertiseLinkResult = 'failed';
      throw error;
    }
  } else {
    opts.attemptState.expertiseLinkResult = 'skipped_no_expertise_ids';
  }

  if (mappedExpertise.items.length > 0) {
    opts.logger.info('vincere.write.update_expertise_links', {
      sourceId: opts.sourceId,
      candidateId: opts.candidateId,
      dryRun: Boolean(opts.dryRun),
      expertiseLinkCount: mappedExpertise.items.length
    });

    if (!opts.dryRun) {
      await opts.vincereClient.updateExpertiseLinks(opts.candidateId, mappedExpertise.items);
    }
  }

  const selectedCv = selectCvAttachment(opts.attachments ?? []);
  if (!selectedCv) {
    opts.attemptState.documentUploadAttempted = false;
    opts.attemptState.documentUploadResult = 'skipped_no_supported_document';
    return;
  }

  opts.attemptState.documentUploadAttempted = true;
  opts.attemptState.resolvedUploadCandidateId = opts.candidateId;
  opts.logger.info('vincere.write.upload_candidate_document', {
    sourceId: opts.sourceId,
    candidateId: opts.candidateId,
    dryRun: Boolean(opts.dryRun),
    filename: selectedCv.filename,
    mimeType: selectedCv.mimeType,
    size: selectedCv.size
  });

  try {
    if (!opts.dryRun) {
      await opts.vincereClient.uploadCandidateDocument(opts.candidateId, {
        filename: selectedCv.filename,
        mimeType: selectedCv.mimeType,
        data: selectedCv.data
      });
    }
    opts.attemptState.documentUploadResult = 'uploaded';
    opts.attemptState.documentUploadErrorText = null;
  } catch (error) {
    opts.attemptState.documentUploadResult = 'failed';
    opts.attemptState.documentUploadErrorText = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

type SyncAttemptState = Omit<VincereSyncAttemptRecorderInput, 'sourceId' | 'resultStatus' | 'errorText'>;

function createAttemptState(sourceId: string): SyncAttemptState {
  return {
    messageId: sourceId,
    candidateLookupOutcome: 'skipped_no_email',
    candidateUpsertOutcome: null,
    expertiseLinkPayload: null,
    expertiseLinkResult: null,
    documentUploadAttempted: false,
    documentUploadResult: null,
    documentUploadErrorText: null,
    resolvedUploadCandidateId: null
  };
}

async function lookupCandidateIdByEmail(opts: {
  attemptState: SyncAttemptState;
  payload: VincereSyncCandidatePayload;
  vincereClient: VincereClient;
}): Promise<string | null> {
  const email = opts.payload.email?.trim();
  if (!email) {
    opts.attemptState.candidateLookupOutcome = 'skipped_no_email';
    return null;
  }

  const emailCandidate = await opts.vincereClient.findCandidateByEmail(email);
  const candidateId = emailCandidate?.id ?? null;
  opts.attemptState.candidateLookupOutcome = candidateId
    ? JSON.stringify({ step: 'candidate_lookup', status: 'found', email, candidateId })
    : JSON.stringify({ step: 'candidate_lookup', status: 'missing', email });
  return candidateId;
}

async function persistSyncAttempt(
  recorder: ((attempt: VincereSyncAttemptRecorderInput) => Promise<void> | void) | undefined,
  attemptState: SyncAttemptState,
  resultStatus: VincereSyncAttemptRecorderInput['resultStatus'],
  errorText: string | null
): Promise<void> {
  if (!recorder) return;
  await recorder({
    sourceId: attemptState.messageId,
    ...attemptState,
    resultStatus,
    errorText
  });
}

function dedupeIds(ids: string[] | undefined): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
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
