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
import { requestLlmRawText } from '../pipeline/extraction/llmClient.js';
import { ExtractionParseError, parseTagExplanations } from '../pipeline/extraction/parseTagExplanations.js';
import { sortExtractionTags } from '../pipeline/extractionResult.js';
import { evaluateReviewPolicy } from '../pipeline/reviewPolicy.js';
import { mapTagsToExpertiseLinks } from '../vincere/expertiseMapping.js';

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
      try {
        // 1) Run cleaning pipeline.
        const cleaned = runCleaningPipeline({
          raw_text: msg.screeningSourceText ?? msg.snippet ?? msg.subject ?? '',
          body_text: msg.screeningSourceText,
          provenance: msg.provenance,
          message_id: msg.messageId
        });

        throwOnCleaningErrors(cleaned, msg.messageId);

        // 2) Run LLM extraction.
        const rawModelOutput = await requestLlmRawText(
          {
            apiKey: config.llm.apiKey,
            model: config.llm.model,
            timeoutMs: config.llm.timeoutMs,
            retries: config.llm.maxRetries
          },
          {
            resumeText: cleaned.clean_text,
            messageId: msg.messageId,
            contentHash: msg.contentHash
          }
        );

        // 3) Parse/validate tags.
        let extraction: {
          status: 'parsed' | 'rejected' | 'error';
          rawModelOutput: string;
          parsedJson: string | null;
          rejectionReason: string | null;
          modelName: string;
          promptVersion: string;
          tags: string[];
        };

        try {
          const parsed = parseTagExplanations(rawModelOutput);
          if (parsed.status === 'rejected') {
            extraction = {
              status: 'rejected',
              rawModelOutput,
              parsedJson: null,
              rejectionReason: parsed.rejection_reason,
              modelName: config.llm.model,
              promptVersion: 'semiverif-v2',
              tags: []
            };
          } else {
            const tags = sortExtractionTags(parsed.tag_explanations.map((entry) => entry.tag));
            extraction = {
              status: 'parsed',
              rawModelOutput,
              parsedJson: JSON.stringify({
                tags,
                explanations: Object.fromEntries(parsed.tag_explanations.map((entry) => [entry.tag, entry.explanation]))
              }),
              rejectionReason: null,
              modelName: config.llm.model,
              promptVersion: 'semiverif-v2',
              tags
            };
          }
        } catch (error) {
          const reason = error instanceof ExtractionParseError
            ? `Extraction parse failed (${error.code})`
            : 'Extraction parse failed';
          extraction = {
            status: 'error',
            rawModelOutput,
            parsedJson: null,
            rejectionReason: reason,
            modelName: config.llm.model,
            promptVersion: 'semiverif-v2',
            tags: []
          };
        }

        // 4) Persist extraction row.
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

        // 5) Run candidate lookup/upsert + expertise link + doc upload.
        const candidateIdentifier = (msg.from ?? '').trim() || `message:${msg.messageId}`;
        const expertiseMapping = mapTagsToExpertiseLinks(extraction.tags);
        const hasUploadableDocument = msg.attachments.some((attachment) => !attachment.rejected && Boolean(attachment.data?.length));

        pipelineStore.insertVincereSyncAttempt({
          messageId: msg.messageId,
          candidateIdentifier,
          matchOutcome: 'no_match',
          matchedCandidateId: null,
          tagsProposed: JSON.stringify(extraction.tags),
          tagsApplied: JSON.stringify([]),
          resultStatus: 'skipped',
          errorText: null,
          candidateLookupOutcome: 'skipped_cli_not_configured',
          candidateUpsertOutcome: 'skipped_cli_not_configured',
          expertiseLinkPayload: JSON.stringify(expertiseMapping.items),
          expertiseLinkResult: expertiseMapping.manualReviewReason ? 'manual_review_required' : 'skipped_cli_not_configured',
          documentUploadAttempted: hasUploadableDocument,
          documentUploadResult: hasUploadableDocument ? 'skipped_cli_not_configured' : 'not_attempted',
          documentUploadErrorText: null,
          resolvedUploadCandidateId: null
        });

        // 6) Persist sync attempt and optional manual-review queue item.
        const reviewDecision = evaluateReviewPolicy({
          vincereTags: extraction.tags,
          hasAmbiguousCandidateMatch: false,
          isRejectedOutput: extraction.status === 'rejected'
        });

        const requiresManualReview = extraction.status !== 'parsed'
          || expertiseMapping.manualReviewReason !== null
          || reviewDecision.manualReviewQueueRecord !== null;

        if (requiresManualReview) {
          pipelineStore.upsertManualReviewQueue({
            reason: extraction.status === 'error' ? 'extraction_error' : 'sync_error',
            messageId: msg.messageId,
            candidateHints: JSON.stringify({ from: msg.from, subject: msg.subject }),
            payloadSnapshot: JSON.stringify({ extraction, reviewDecision, expertiseMapping })
          });
        }

        process.stdout.write(`${JSON.stringify(cleaned)}\n`);
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
          modelName: config.llm.model,
          promptVersion: 'semiverif-v2'
        });
        pipelineStore.upsertManualReviewQueue({
          reason: 'extraction_error',
          messageId: msg.messageId,
          candidateHints: JSON.stringify({ from: msg.from, subject: msg.subject }),
          payloadSnapshot: JSON.stringify({ error: errorText })
        });
      }
    }
  });

  process.stdout.write(`${JSON.stringify(summary)}\n`);

  const summaryErrorMessage = getSummaryErrorMessage(summary);
  if (summaryErrorMessage) {
    throw new Error(summaryErrorMessage);
  }
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
