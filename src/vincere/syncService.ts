import { createLogger, redact } from '../observability/logger.js';
import { VincereClient } from './client.js';
import { CandidateIdentity, CandidateMatchInput, matchCandidates } from './matching.js';

export type VincereSyncCandidatePayload = CandidateMatchInput & {
  id?: string;
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
  vincereClient: VincereClient;
  reviewQueue: ManualReviewQueue;
  dryRun?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}): Promise<SyncResult> {
  const logger = createLogger(opts.logLevel ?? 'info');
  const matches = matchCandidates(opts.payload, opts.existingCandidates);
  const plausible = matches.filter((m) => m.confidence !== 'low');

  if (plausible.length === 1 && plausible[0]) {
    const candidateId = plausible[0].candidateId;
    const path = `/api/candidate/${encodeURIComponent(candidateId)}`;
    logger.info('vincere.write.update_candidate', {
      sourceId: opts.sourceId,
      candidateId,
      dryRun: Boolean(opts.dryRun),
      strategy: plausible[0].strategy,
      score: plausible[0].score,
      payload: redact(opts.payload)
    });

    if (!opts.dryRun) {
      await opts.vincereClient.patch(path, opts.payload);
    }

    return { disposition: 'updated', candidateId };
  }

  if (plausible.length === 0) {
    const path = '/api/candidate';
    logger.info('vincere.write.create_candidate', {
      sourceId: opts.sourceId,
      dryRun: Boolean(opts.dryRun),
      payload: redact(opts.payload)
    });

    if (!opts.dryRun) {
      const created = await opts.vincereClient.post<{ id: string }>(path, opts.payload);
      return { disposition: 'created', candidateId: created.id };
    }

    return { disposition: 'created', candidateId: 'dry-run' };
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
