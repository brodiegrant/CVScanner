import { loadConfig } from '../config/config.js';
import { createLogger } from '../observability/logger.js';
import { SqliteTokenStore } from '../storage/sqlite/sqliteTokenStore.js';
import { connectAccount } from '../gmail/oauth/oauthClient.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const tokenStore = new SqliteTokenStore(config.sqlitePath, config.tokenEncKey);
  const result = await connectAccount(config, tokenStore);
  logger.info('Connected Gmail account', { accountEmail: result.accountEmail });
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
