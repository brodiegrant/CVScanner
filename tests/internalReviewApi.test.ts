import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqlitePipelineStore } from '../src/storage/sqlite/sqlitePipelineStore.js';
import { createInternalReviewApiApp } from '../src/review/internalReviewApi.js';

async function withServer<T>(fn: (baseUrl: string, store: SqlitePipelineStore) => Promise<T>): Promise<T> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-api-'));
  const dbPath = path.join(tmp, 'state.sqlite3');
  const store = new SqlitePipelineStore(dbPath);
  const app = createInternalReviewApiApp(store);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await fn(baseUrl, store);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

describe('internal review API', () => {
  it('returns manual review queue and item details, then resolves an item', async () => {
    await withServer(async (baseUrl, store) => {
      store.upsertCandidateExtraction({
        accountEmail: 'acct@example.com',
        messageId: 'm-1',
        contentHash: 'hash',
        status: 'parsed',
        rawModelOutput: JSON.stringify({
          tags: ['signal:strong'],
          explanations: [{ tag: 'signal:strong', explanation: 'Derived from deterministic cleaning signals.' }]
        }),
        parsedJson: JSON.stringify({ tags: ['signal:strong'] }),
        rejectionReason: null,
        modelName: 'test-model',
        promptVersion: 'v1'
      });
      store.upsertManualReviewQueue({
        reason: 'ambiguous_match',
        messageId: 'm-1',
        candidateHints: JSON.stringify({ from: 'alice@example.com' }),
        payloadSnapshot: JSON.stringify({
          extraction: { tags: ['signal:strong'] },
          matching: { matchOutcome: 'ambiguous' },
          syncResult: { status: 'error' }
        })
      });

      const queueRes = await fetch(`${baseUrl}/review/queue`);
      expect(queueRes.status).toBe(200);
      const queueJson = await queueRes.json() as { items: Array<{ id: string }> };
      expect(queueJson.items).toHaveLength(1);
      expect(queueJson.items[0]?.id).toBe('m-1');

      const itemRes = await fetch(`${baseUrl}/review/item/m-1`);
      expect(itemRes.status).toBe(200);
      const itemJson = await itemRes.json() as any;
      expect(itemJson.extraction.parsed.tags).toContain('signal:strong');
      expect(itemJson.extraction.explanations).toHaveLength(1);
      expect(itemJson.matchContext.matching.matchOutcome).toBe('ambiguous');

      const resolveRes = await fetch(`${baseUrl}/review/item/m-1/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', notes: 'safe to proceed' })
      });
      expect(resolveRes.status).toBe(200);

      const queueAfterRes = await fetch(`${baseUrl}/review/queue`);
      const queueAfterJson = await queueAfterRes.json() as { items: Array<{ id: string }> };
      expect(queueAfterJson.items).toHaveLength(0);
    });
  });
});
