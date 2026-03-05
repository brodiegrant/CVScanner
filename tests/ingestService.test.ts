import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingestOnce } from '../src/gmail/ingest/ingestService.js';
import { SqliteCursorStore } from '../src/storage/sqlite/sqliteCursorStore.js';
import { NoopMetrics } from '../src/observability/metrics.js';

const config = {
  defaultLabel: 'Process',
  dedupeLookbackDays: 14,
  logLevel: 'info',
  allowedAttachmentExtensions: ['pdf', 'doc', 'docx'],
  ingestBodyMaxChars: 1000,
  ingestIncludeBody: true
} as any;

class FakeGmail {
  constructor(private failOn?: string) {}
  async listMessageIds() { return ['m1', 'm2']; }
  async getMessageMetadata(id: string) { return { messageId: id, internalDate: id === 'm1' ? 1000 : 2000, bodyText: 'screen answers' }; }
  async getAttachments(id: string) {
    if (this.failOn === id) throw new Error('download failed');
    return [{ filename: `${id}.pdf`, size: 10 }];
  }
}

describe('ingestOnce', () => {
  it('is idempotent across multiple runs', async () => {
    const dbPath = path.join(os.tmpdir(), `cvscanner-ing-${Date.now()}.db`);
    const store = new SqliteCursorStore(dbPath);
    const seen: string[] = [];

    const r1 = await ingestOnce({ accountEmail: 'a@b.com', config, gmailClient: new FakeGmail() as any, cursorStore: store, metrics: new NoopMetrics(), onMessage: async (m) => { seen.push(m.messageId); } });
    expect(r1.counts.processed).toBe(2);

    const r2 = await ingestOnce({ accountEmail: 'a@b.com', config, gmailClient: new FakeGmail() as any, cursorStore: store, metrics: new NoopMetrics(), onMessage: async (m) => { seen.push(m.messageId); } });
    expect(r2.counts.processed).toBe(0);
  });

  it('does not advance cursor past failed message', async () => {
    const dbPath = path.join(os.tmpdir(), `cvscanner-ing2-${Date.now()}.db`);
    const store = new SqliteCursorStore(dbPath);

    const r = await ingestOnce({ accountEmail: 'a@b.com', config, gmailClient: new FakeGmail('m2') as any, cursorStore: store, metrics: new NoopMetrics(), onMessage: async () => {} });
    expect(r.errors.length).toBe(1);
    const cursor = store.getCursor('a@b.com', 'Process');
    expect(cursor?.lastSuccessInternalDate).toBe(1000);
  });
});
