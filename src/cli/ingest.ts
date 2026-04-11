import { loadConfig } from '../config/config.js';
import { JsonlMetricsSink } from '../observability/metricsJsonlSink.js';
import { NoopMetrics } from '../observability/metrics.js';
import { SqliteTokenStore } from '../storage/sqlite/sqliteTokenStore.js';
import { SqliteCursorStore } from '../storage/sqlite/sqliteCursorStore.js';
import { SqlitePipelineStore } from '../storage/sqlite/sqlitePipelineStore.js';
import { SqliteExtractionStore } from '../storage/sqlite/sqliteExtractionStore.js';
import { createAuthorizedClient } from '../gmail/oauth/oauthClient.js';
import { GmailClient } from '../gmail/client/gmailClient.js';
import { ingestOnce } from '../gmail/ingest/ingestService.js';
import { pathToFileURL } from 'node:url';
import type { RunSummary } from '../gmail/ingest/ingestService.js';
import { runCleaningPipeline } from '../pipeline/cleaning/pipeline.js';
import type { CleaningOutputDto } from '../pipeline/cleaning/types.js';
import { buildExtractionCandidate } from '../pipeline/extraction/buildExtractionCandidate.js';

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
  const extractionStore = new SqliteExtractionStore(config.sqlitePath);
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
      try {
        const cleaned = runCleaningPipeline({
          raw_text: msg.screeningSourceText ?? msg.snippet ?? msg.subject ?? '',
          body_text: msg.screeningSourceText,
          provenance: msg.provenance,
          message_id: msg.messageId
        });

        throwOnCleaningErrors(cleaned, msg.messageId);

        const extraction = buildExtractionCandidate(cleaned);
        const rawModelOutput = JSON.stringify(extraction.rawModelOutput);

        extractionStore.insertExtractionAttempt({
          extractionKey: msg.messageId,
          status: extraction.status,
          rawModelOutput,
          parsedTagExplanationJson: extraction.parsedTagExplanationJson,
          rejectionReason: extraction.rejectionReason,
          modelName: extraction.modelName,
          promptVersion: extraction.promptVersion,
          errorDetails: null
        });

        pipelineStore.upsertCandidateExtraction({
          accountEmail: account,
          messageId: msg.messageId,
          contentHash: msg.contentHash ?? null,
          status: extraction.status,
          rawModelOutput,
          parsedJson: extraction.parsedTagExplanationJson,
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

        if (extraction.tags.length < 2) {
          pipelineStore.upsertManualReviewQueue({
            reason: 'low_tag_count',
            messageId: msg.messageId,
            candidateHints: JSON.stringify({ from: msg.from, subject: msg.subject }),
            payloadSnapshot: JSON.stringify({ extraction, matching, syncResult })
          });
        }

        if (matching.matchOutcome === 'ambiguous') {
          pipelineStore.upsertManualReviewQueue({
            reason: 'ambiguous_match',
            messageId: msg.messageId,
            candidateHints: JSON.stringify({ from: msg.from, subject: msg.subject }),
            payloadSnapshot: JSON.stringify({ extraction, matching, syncResult })
          });
        }

        if (syncResult.status === 'error') {
          pipelineStore.upsertManualReviewQueue({
            reason: 'sync_error',
            messageId: msg.messageId,
            candidateHints: JSON.stringify({ from: msg.from, subject: msg.subject }),
            payloadSnapshot: JSON.stringify({ extraction, matching, syncResult })
          });
        }

        process.stdout.write(`${JSON.stringify(cleaned)}\n`);
      } catch (err) {
        extractionStore.insertExtractionAttempt({
          extractionKey: msg.messageId,
          status: 'error',
          rawModelOutput: JSON.stringify({ error: true }),
          parsedTagExplanationJson: null,
          rejectionReason: null,
          modelName: 'deterministic-cleaning-derived',
          promptVersion: 'v1',
          errorDetails: JSON.stringify({
            message: err instanceof Error ? err.message : String(err),
            messageId: msg.messageId
          })
        });
        throw err;
      }
    }
  });

  process.stdout.write(`${JSON.stringify(summary)}\n`);

  const summaryErrorMessage = getSummaryErrorMessage(summary);
  if (summaryErrorMessage) {
    throw new Error(summaryErrorMessage);
  }
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
