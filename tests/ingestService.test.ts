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
  public lastSince = -1;
  constructor(private failOn?: string) {}
  async listMessageIds(_label: string, afterInternalDateMs: number) {
    this.lastSince = afterInternalDateMs;
    if (afterInternalDateMs > 1000) return [];
    return ['m1', 'm2'];
  }
  async getMessageMetadata(id: string) { return { messageId: id, internalDate: 1000, bodyText: 'screen answers' }; }
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

  it('re-queries with overlap to recover failed same-timestamp messages', async () => {
    const dbPath = path.join(os.tmpdir(), `cvscanner-ing3-${Date.now()}.db`);
    const store = new SqliteCursorStore(dbPath);

    const failing = new FakeGmail('m2');
    const r1 = await ingestOnce({ accountEmail: 'a@b.com', config, gmailClient: failing as any, cursorStore: store, metrics: new NoopMetrics(), onMessage: async () => {} });
    expect(r1.counts.processed).toBe(1);

    const recovered = new FakeGmail();
    const r2 = await ingestOnce({ accountEmail: 'a@b.com', config, gmailClient: recovered as any, cursorStore: store, metrics: new NoopMetrics(), onMessage: async () => {} });
    expect(recovered.lastSince).toBe(0);
    expect(r2.counts.processed).toBe(1);
    expect(r2.processed_message_ids).toEqual(['m2']);
  });
});
