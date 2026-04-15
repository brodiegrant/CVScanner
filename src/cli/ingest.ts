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
import { parseTagExplanations, ExtractionParseError } from '../pipeline/extraction/parseTagExplanations.js';
import { evaluateReviewPolicy, ManualReviewReasonCode, type ManualReviewReasonCode as PolicyReviewReasonCode } from '../pipeline/reviewPolicy.js';
import type { ManualReviewQueueRow } from '../storage/sqlite/sqlitePipelineStore.js';

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
      let extraction: ReturnType<typeof buildExtractionCandidate>;
      try {
        throwOnCleaningErrors(cleaned, msg.messageId);
        extraction = buildExtractionCandidate(cleaned);

        pipelineStore.upsertCandidateExtraction({
          accountEmail: account,
          messageId: msg.messageId,
          contentHash: msg.contentHash ?? null,
          status: extraction.status,
          rawModelOutput: extraction.rawModelOutput,
          parsedJson: extraction.parsedJson,
          rejectionReason: extraction.rejectionReason,
          modelName: extraction.modelName,
          promptVersion: extraction.promptVersion
        });
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        pipelineStore.upsertCandidateExtraction({
          accountEmail: account,
          messageId: msg.messageId,
          contentHash: msg.contentHash ?? null,
          status: 'error',
          rawModelOutput: JSON.stringify({ error: errorText }),
          parsedJson: null,
          rejectionReason: errorText,
          modelName: 'deterministic-cleaning-derived',
          promptVersion: 'v1'
        });
        pipelineStore.upsertManualReviewQueue({
          reason: 'extraction_error',
          messageId: msg.messageId,
          candidateHints: JSON.stringify({ from: msg.from, subject: msg.subject }),
          payloadSnapshot: JSON.stringify({
            stage: 'extraction',
            quarantined: true,
            cleaned,
            error: errorText
          })
        });
        return;
      }

      let matching:
        | ReturnType<typeof matchCandidate>
        | undefined;
      let syncResult:
        | ReturnType<typeof syncToVincere>
        | undefined;
      try {
        matching = matchCandidate(msg, extraction.tags);
        syncResult = syncToVincere(msg, extraction.tags, matching);

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
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        pipelineStore.insertVincereSyncAttempt({
          messageId: msg.messageId,
          candidateIdentifier: msg.from ?? `message:${msg.messageId}`,
          matchOutcome: 'no_match',
          matchedCandidateId: null,
          tagsProposed: JSON.stringify(extraction.tags),
          tagsApplied: JSON.stringify([]),
          resultStatus: 'error',
          errorText
        });
        pipelineStore.upsertManualReviewQueue({
          reason: 'sync_error',
          messageId: msg.messageId,
          candidateHints: JSON.stringify({ from: msg.from, subject: msg.subject }),
          payloadSnapshot: JSON.stringify({
            stage: 'sync_or_upload',
            quarantined: true,
            extraction,
            error: errorText
          })
        });
        return;
      }

      const reviewDecision = evaluateReviewPolicy({
        vincereTags: extraction.tags,
        hasAmbiguousCandidateMatch: matching.matchOutcome === 'ambiguous',
        isRejectedOutput: extraction.status === 'rejected'
      });

      if (reviewDecision.manualReviewQueueRecord !== null) {
        pipelineStore.upsertManualReviewQueue({
          reason: mapPolicyReasonToQueueReason(reviewDecision.manualReviewQueueRecord.reasonCode),
          messageId: msg.messageId,
          candidateHints: JSON.stringify({ from: msg.from, subject: msg.subject }),
          payloadSnapshot: JSON.stringify({ extraction, matching, syncResult, reviewDecision })
        });
      }

      if (syncResult.status === 'error') {
        pipelineStore.upsertManualReviewQueue({
          reason: 'sync_error',
          messageId: msg.messageId,
          candidateHints: JSON.stringify({ from: msg.from, subject: msg.subject }),
          payloadSnapshot: JSON.stringify({
            stage: 'sync_or_upload',
            quarantined: true,
            extraction,
            matching,
            syncResult
          })
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

function mapPolicyReasonToQueueReason(reasonCode: PolicyReviewReasonCode): ManualReviewQueueRow['reason'] {
  switch (reasonCode) {
    case ManualReviewReasonCode.AmbiguousCandidateMatch:
      return 'ambiguous_match';
    case ManualReviewReasonCode.LowNonLocationTagCount:
    case ManualReviewReasonCode.RejectedOutput:
      return 'low_tag_count';
    default: {
      const exhaustiveCheck: never = reasonCode;
      throw new Error(`Unhandled review policy reason: ${String(exhaustiveCheck)}`);
    }
  }
}

function buildExtractionCandidate(cleaned: Pick<CleaningOutputDto, 'signals' | 'pii'>): {
  status: 'parsed' | 'rejected' | 'error';
  rawModelOutput: string;
  parsedJson: string | null;
  rejectionReason: string | null;
  modelName: string;
  promptVersion: string;
  tags: string[];
} {
  const rawModelOutputLines: string[] = [];

  if (cleaned.signals.confidence >= 0.8) {
    rawModelOutputLines.push('signal:strong');
    rawModelOutputLines.push('High confidence was derived from deterministic cleaning signals.');
  }

  if (cleaned.signals.confidence <= 0.4) {
    rawModelOutputLines.push('signal:weak');
    rawModelOutputLines.push('Low confidence was derived from deterministic cleaning signals.');
  }

  if (cleaned.signals.raw_length >= 1500) {
    rawModelOutputLines.push('scope:global');
    rawModelOutputLines.push('Long-form resume content suggests broad/global role scope.');
  }

  if (cleaned.pii.contains_email) {
    rawModelOutputLines.push('signal:medium');
    rawModelOutputLines.push('Contact signal was detected in candidate-provided details.');
  }

  if (rawModelOutputLines.length === 0) {
    return {
      status: 'rejected',
      rawModelOutput: 'reject\nNo extraction tags produced from cleaning signals',
      parsedJson: null,
      rejectionReason: 'No extraction tags produced from cleaning signals',
      modelName: 'deterministic-cleaning-derived',
      promptVersion: 'v2-tag-explanation-canonical',
      tags: []
    };
  }

  rawModelOutputLines.push('tier:t2');
  rawModelOutputLines.push('Deterministic extraction produced enough non-reject signal to classify as tier t2.');
  const rawModelOutput = rawModelOutputLines.join('\n');

  try {
    const parsed = parseTagExplanations(rawModelOutput);
    if (parsed.status === 'rejected') {
      return {
        status: 'rejected',
        rawModelOutput,
        parsedJson: null,
        rejectionReason: parsed.rejection_reason,
        modelName: 'deterministic-cleaning-derived',
        promptVersion: 'v2-tag-explanation-canonical',
        tags: []
      };
    }

    const tags = sortExtractionTags(parsed.tag_explanations.map((entry) => entry.tag));
    const parsedJson = JSON.stringify({
      tags,
      explanations: Object.fromEntries(parsed.tag_explanations.map((entry) => [entry.tag, entry.explanation]))
    });

    return {
      status: 'parsed',
      rawModelOutput,
      parsedJson,
      rejectionReason: null,
      modelName: 'deterministic-cleaning-derived',
      promptVersion: 'v2-tag-explanation-canonical',
      tags
    };
  } catch (error) {
    const reason = error instanceof ExtractionParseError
      ? `Extraction parse failed (${error.code})`
      : 'Extraction parse failed';

    return {
      status: 'error',
      rawModelOutput,
      parsedJson: null,
      rejectionReason: reason,
      modelName: 'deterministic-cleaning-derived',
      promptVersion: 'v2-tag-explanation-canonical',
      tags: []
    };
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
