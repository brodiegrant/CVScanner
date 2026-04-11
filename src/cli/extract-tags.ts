import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/config.js';
import { runCleaningPipeline } from '../pipeline/cleaning/pipeline.js';
import { buildExtractionCandidate } from '../pipeline/extraction/buildExtractionCandidate.js';
import { SqliteExtractionStore } from '../storage/sqlite/sqliteExtractionStore.js';
import { buildIngestProvenance } from '../pipeline/provenance.js';

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

async function main() {
  const config = loadConfig();
  const text = arg('text');
  if (!text) throw new Error('--text is required');

  const messageId = arg('message-id');
  const extractionKey = messageId ?? `cli-run:${crypto.randomUUID()}`;
  const extractionStore = new SqliteExtractionStore(config.sqlitePath);

  try {
    const cleaned = runCleaningPipeline({
      raw_text: text,
      body_text: text,
      message_id: extractionKey,
      provenance: buildIngestProvenance({
        runId: extractionKey,
        accountEmail: 'cli@local',
        label: 'cli-extract-tags',
        messageId: extractionKey,
        internalDate: Date.now(),
        screeningSourceText: text,
        attachments: []
      })
    });

    if (cleaned.errors.length > 0) {
      const firstError = cleaned.errors[0];
      throw new Error(
        `cleaning failed for ${extractionKey} with ${cleaned.errors.length} error(s): ` +
        `${firstError?.kind}/${firstError?.stage} ${firstError?.message}`
      );
    }

    const extraction = buildExtractionCandidate(cleaned);
    extractionStore.insertExtractionAttempt({
      extractionKey,
      status: extraction.status,
      rawModelOutput: JSON.stringify(extraction.rawModelOutput),
      parsedTagExplanationJson: extraction.parsedTagExplanationJson,
      rejectionReason: extraction.rejectionReason,
      modelName: extraction.modelName,
      promptVersion: extraction.promptVersion,
      errorDetails: null
    });

    process.stdout.write(`${JSON.stringify({ extractionKey, extraction })}\n`);
  } catch (err) {
    extractionStore.insertExtractionAttempt({
      extractionKey,
      status: 'error',
      rawModelOutput: JSON.stringify({ error: true }),
      parsedTagExplanationJson: null,
      rejectionReason: null,
      modelName: 'deterministic-cleaning-derived',
      promptVersion: 'v1',
      errorDetails: JSON.stringify({ message: err instanceof Error ? err.message : String(err), extractionKey })
    });
    throw err;
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryUrl === import.meta.url) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
