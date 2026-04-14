import { loadConfig } from '../config/config.js';
import { JsonlMetricsSink } from '../observability/metricsJsonlSink.js';
import { NoopMetrics } from '../observability/metrics.js';
import { SqliteTokenStore } from '../storage/sqlite/sqliteTokenStore.js';
import { SqliteCursorStore } from '../storage/sqlite/sqliteCursorStore.js';
import { SqlitePipelineStore } from '../storage/sqlite/sqlitePipelineStore.js';
import { createAuthorizedClient } from '../gmail/oauth/oauthClient.js';
import { GmailClient } from '../gmail/client/gmailClient.js';
import { ingestOnce } from '../gmail/ingest/ingestService.js';
import { pathToFileURL } from 'node:url';
import type { RunSummary } from '../gmail/ingest/ingestService.js';
import { runCleaningPipeline } from '../pipeline/cleaning/pipeline.js';
import type { CleaningOutputDto } from '../pipeline/cleaning/types.js';
import { sortExtractionTags } from '../pipeline/extractionResult.js';
import { evaluateReviewPolicy } from '../pipeline/reviewPolicy.js';

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

async function main() {
  const config = loadConfig();
  const account = arg('account');
  const label = arg('label') ?? config.defaultLabel;
  const dryRun = process.argv.includes('--dry-run');
  if (!account) throw new Error('--account is required');

  const tokenStore = new SqliteTokenStore(config.sqlitePath, config.tokenEncKey);
  const cursorStore = new SqliteCursorStore(config.sqlitePath);
  const pipelineStore = new SqlitePipelineStore(config.sqlitePath);
  const auth = createAuthorizedClient(config, tokenStore, account);
  const gmailClient = new GmailClient(auth);
  const metrics = config.metricsEnabled ? new JsonlMetricsSink(config.metricsJsonlPath) : new NoopMetrics();

  const summary = await ingestOnce({
    accountEmail: account,
    label,
    dryRun,
    config,
    gmailClient,
    cursorStore,
    metrics,
    onMessage: async (msg) => {
      const cleaned = runCleaningPipeline({
        raw_text: msg.screeningSourceText ?? msg.snippet ?? msg.subject ?? '',
        body_text: msg.screeningSourceText,
        provenance: msg.provenance,
        message_id: msg.messageId
      });

      throwOnCleaningErrors(cleaned, msg.messageId);

      const extraction = buildExtractionCandidate(cleaned);
      const rawModelOutput = JSON.stringify(extraction.rawModelOutput);

      pipelineStore.upsertCandidateExtraction({
        accountEmail: account,
        messageId: msg.messageId,
        contentHash: msg.contentHash ?? null,
        status: extraction.status,
        rawModelOutput,
        parsedJson: extraction.parsedJson,
        rejectionReason: extraction.rejectionReason,
        modelName: extraction.modelName,
        promptVersion: extraction.promptVersion
      });

      const matching = matchCandidate(msg, extraction.tags);
      const syncResult = syncToVincere(msg, extraction.tags, matching);

      pipelineStore.insertVincereSyncAttempt({
        messageId: msg.messageId,
        candidateIdentifier: matching.candidateIdentifier,
        matchOutcome: matching.matchOutcome,
        matchedCandidateId: matching.matchedCandidateId,
        tagsProposed: JSON.stringify(extraction.tags),
        tagsApplied: JSON.stringify(syncResult.tagsApplied),
        resultStatus: syncResult.status,
        errorText: syncResult.errorText
      });

      const reviewDecision = evaluateReviewPolicy({
        vincereTags: extraction.tags,
        hasAmbiguousCandidateMatch: matching.matchOutcome === 'ambiguous',
        isRejectedOutput: extraction.status === 'rejected'
      });

      if (reviewDecision.manualReviewQueueRecord !== null) {
        pipelineStore.upsertManualReviewQueue({
          reason: reviewDecision.manualReviewQueueRecord.reasonCode,
          messageId: msg.messageId,
          candidateHints: JSON.stringify({ from: msg.from, subject: msg.subject }),
          payloadSnapshot: JSON.stringify({ extraction, matching, syncResult, reviewDecision })
        });
      }

      if (syncResult.status === 'error') {
        pipelineStore.upsertManualReviewQueue({
          reason: 'SYNC_ERROR',
          messageId: msg.messageId,
          candidateHints: JSON.stringify({ from: msg.from, subject: msg.subject }),
          payloadSnapshot: JSON.stringify({ extraction, matching, syncResult })
        });
      }

      process.stdout.write(`${JSON.stringify(cleaned)}\n`);
    }
  });

  process.stdout.write(`${JSON.stringify(summary)}\n`);

  const summaryErrorMessage = getSummaryErrorMessage(summary);
  if (summaryErrorMessage) {
    throw new Error(summaryErrorMessage);
  }
}

function buildExtractionCandidate(cleaned: Pick<CleaningOutputDto, 'signals' | 'pii'>): {
  status: 'parsed' | 'rejected';
  rawModelOutput: Record<string, unknown>;
  parsedJson: string;
  rejectionReason: string | null;
  modelName: string;
  promptVersion: string;
  tags: string[];
} {
  const derivedTags: string[] = [];

  if (cleaned.signals.confidence >= 0.8) derivedTags.push('signal:strong');
  if (cleaned.signals.confidence <= 0.4) derivedTags.push('signal:weak');
  if (cleaned.signals.raw_length >= 1500) derivedTags.push('scope:global');
  if (cleaned.pii.contains_email) derivedTags.push('signal:contact_info');

  const tags = sortExtractionTags(derivedTags);
  const rawModelOutput = {
    tags,
    explanations: tags.map((tag) => ({ tag, explanation: `Derived from deterministic cleaning signals for ${tag}.` }))
  };

  return {
    status: tags.length > 0 ? 'parsed' : 'rejected',
    rawModelOutput,
    parsedJson: JSON.stringify(rawModelOutput),
    rejectionReason: tags.length > 0 ? null : 'No extraction tags produced from cleaning signals',
    modelName: 'deterministic-cleaning-derived',
    promptVersion: 'v1',
    tags
  };
}

function matchCandidate(
  msg: { messageId: string; from?: string },
  tags: string[]
): { candidateIdentifier: string; matchOutcome: 'matched' | 'no_match' | 'ambiguous'; matchedCandidateId: string | null } {
  const candidateIdentifier = (msg.from ?? '').trim() || `message:${msg.messageId}`;
  const hasAmbiguitySignal = tags.includes('signal:weak');

  if (hasAmbiguitySignal) {
    return {
      candidateIdentifier,
      matchOutcome: 'ambiguous',
      matchedCandidateId: null
    };
  }

  return {
    candidateIdentifier,
    matchOutcome: 'no_match',
    matchedCandidateId: null
  };
}

function syncToVincere(
  msg: { messageId: string },
  tags: string[],
  matching: { matchOutcome: 'matched' | 'no_match' | 'ambiguous' }
): { status: 'success' | 'error' | 'skipped'; tagsApplied: string[]; errorText: string | null } {
  if (matching.matchOutcome === 'ambiguous') {
    return {
      status: 'error',
      tagsApplied: [],
      errorText: `Ambiguous candidate match for message ${msg.messageId}`
    };
  }

  return {
    status: matching.matchOutcome === 'matched' ? 'success' : 'skipped',
    tagsApplied: matching.matchOutcome === 'matched' ? tags : [],
    errorText: null
  };
}

export function getSummaryErrorMessage(summary: Pick<RunSummary, 'errors'>): string | undefined {
  if (summary.errors.length === 0) return undefined;

  const firstError = summary.errors[0];
  return `ingest completed with ${summary.errors.length} error(s): ${firstError.kind}/${firstError.stage} ${firstError.message}`;
}

export function throwOnCleaningErrors(cleaned: Pick<CleaningOutputDto, 'errors'>, messageId: string): void {
  if (cleaned.errors.length === 0) return;

  const firstError = cleaned.errors[0];
  throw new Error(
    `cleaning failed for ${messageId} with ${cleaned.errors.length} error(s): ` +
    `${firstError.kind}/${firstError.stage} ${firstError.message}`
  );
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryUrl === import.meta.url) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
