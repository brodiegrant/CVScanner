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
import { parseExtractionResult, sortExtractionTags } from '../pipeline/extractionResult.js';
import { requestLlmRawText } from '../pipeline/extraction/llmClient.js';
import { parseTagExplanations } from '../pipeline/extraction/parseTagExplanations.js';
import { buildExtractionPrompt, EXTRACTION_PROMPT_VERSION } from '../pipeline/extraction/prompt.js';

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

      const extraction = await extractCandidateTags({
        cleanText: cleaned.clean_text,
        messageId: msg.messageId,
        contentHash: msg.contentHash ?? undefined,
        modelName: config.llm.model,
        llmConfig: {
          apiKey: config.llm.apiKey,
          model: config.llm.model,
          timeoutMs: config.llm.timeoutMs,
          retries: config.llm.maxRetries
        }
      });

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
    }
  });

  process.stdout.write(`${JSON.stringify(summary)}\n`);

  const summaryErrorMessage = getSummaryErrorMessage(summary);
  if (summaryErrorMessage) {
    throw new Error(summaryErrorMessage);
  }
}

async function extractCandidateTags(input: {
  cleanText: string;
  messageId: string;
  contentHash?: string;
  modelName: string;
  llmConfig: {
    apiKey: string;
    model: string;
    timeoutMs: number;
    retries: number;
  };
}): Promise<{
  status: 'parsed' | 'rejected' | 'error';
  rawModelOutput: string;
  parsedJson: string;
  rejectionReason: string | null;
  modelName: string;
  promptVersion: string;
  tags: string[];
}> {
  const promptVersion = EXTRACTION_PROMPT_VERSION;

  try {
    const prompt = buildExtractionPrompt(input.cleanText);
    const rawModelOutput = await requestLlmRawText(input.llmConfig, {
      resumeText: prompt,
      messageId: input.messageId,
      contentHash: input.contentHash
    });
    const parsed = parseTagExplanations(rawModelOutput);

    if (parsed.status === 'rejected') {
      const parsedJson = JSON.stringify(parsed);
      return {
        status: 'rejected',
        rawModelOutput,
        parsedJson,
        rejectionReason: parsed.rejection_reason,
        modelName: input.modelName,
        promptVersion,
        tags: []
      };
    }

    const explanations = Object.fromEntries(parsed.tag_explanations.map((entry) => [entry.tag, entry.explanation]));
    const validationResult = parseExtractionResult({
      tags: parsed.tag_explanations.map((entry) => entry.tag),
      explanations,
      location: null
    });
    const sortedTags = sortExtractionTags(validationResult.tags);
    const parsedJson = JSON.stringify({
      status: 'accepted',
      tags: sortedTags,
      explanations
    });

    return {
      status: 'parsed',
      rawModelOutput,
      parsedJson,
      rejectionReason: null,
      modelName: input.modelName,
      promptVersion,
      tags: sortedTags
    };
  } catch (error) {
    return {
      status: 'error',
      rawModelOutput: '',
      parsedJson: JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      }),
      rejectionReason: error instanceof Error ? error.message : String(error),
      modelName: input.modelName,
      promptVersion,
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
