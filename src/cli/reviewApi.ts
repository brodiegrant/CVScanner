import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config/config.js';
import { SqlitePipelineStore } from '../storage/sqlite/sqlitePipelineStore.js';
import { startInternalReviewApi } from '../review/internalReviewApi.js';

async function main() {
  const config = loadConfig();
  const pipelineStore = new SqlitePipelineStore(config.sqlitePath);

  const server = await startInternalReviewApi({
    pipelineStore,
    config: config.reviewApi,
    logger: console
  });

  if (!server) {
    return;
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryUrl === import.meta.url) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
