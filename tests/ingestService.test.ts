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
  public lastSince?: number;

  constructor(
    private failOn?: string,
    private internalDates: Record<string, number> = { m1: 1000, m2: 2000 },
    private ids: string[] = ['m1', 'm2']
  ) {}
  async listMessageIds(_label: string, afterInternalDateMs?: number) {
    this.lastSince = afterInternalDateMs;
    return this.ids;
  }
  async getMessageMetadata(id: string) { return { messageId: id, internalDate: this.internalDates[id] ?? 0, bodyText: 'screen answers' }; }
  async getAttachments(id: string, _allowExtensions?: string[], downloadBytes?: boolean) {
    if (this.failOn === id) throw new Error('download failed');
    return [{ filename: `${id}.pdf`, size: 10, data: downloadBytes ? Buffer.alloc(10) : undefined }];
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

  it('tracks attachment counts separately for found vs downloaded bytes', async () => {
    const dbPath = path.join(os.tmpdir(), `cvscanner-ing4-${Date.now()}.db`);
    const store = new SqliteCursorStore(dbPath);

    const dryRun = await ingestOnce({ accountEmail: 'a@b.com', dryRun: true, config, gmailClient: new FakeGmail() as any, cursorStore: store, metrics: new NoopMetrics(), onMessage: async () => {} });
    expect(dryRun.counts.attachments_found).toBe(2);
    expect(dryRun.counts.attachments_downloaded).toBe(0);

    const normalRun = await ingestOnce({ accountEmail: 'other@b.com', dryRun: false, config, gmailClient: new FakeGmail() as any, cursorStore: store, metrics: new NoopMetrics(), onMessage: async () => {} });
    expect(normalRun.counts.attachments_found).toBe(2);
    expect(normalRun.counts.attachments_downloaded).toBe(20);
  });


  it('recovers failed message with identical internalDate on next run', async () => {
    const dbPath = path.join(os.tmpdir(), `cvscanner-ing3-${Date.now()}.db`);
    const store = new SqliteCursorStore(dbPath);

    const first = await ingestOnce({ accountEmail: 'a@b.com', config, gmailClient: new FakeGmail('m2', { m1: 1000, m2: 1000 }) as any, cursorStore: store, metrics: new NoopMetrics(), onMessage: async () => {} });
    expect(first.counts.processed).toBe(1);
    expect(first.errors.length).toBe(1);

    const second = await ingestOnce({ accountEmail: 'a@b.com', config, gmailClient: new FakeGmail(undefined, { m1: 1000, m2: 1000 }) as any, cursorStore: store, metrics: new NoopMetrics(), onMessage: async () => {} });
    expect(second.counts.processed).toBe(1);
    expect(second.processed_message_ids).toEqual(['m2']);
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

  it('builds ingest provenance with message and attachment origin metadata', async () => {
    const dbPath = path.join(os.tmpdir(), `cvscanner-ing-prov-${Date.now()}.db`);
    const store = new SqliteCursorStore(dbPath);
    let captured: any;

    class ProvenanceGmail extends FakeGmail {
      async getAttachments(id: string, _allowExtensions?: string[], downloadBytes?: boolean) {
        return [{ attachmentId: `att-${id}`, filename: `${id}.pdf`, mimeType: 'application/pdf', size: 10, data: downloadBytes ? Buffer.from('pdf-data') : undefined }];
      }
    }

    await ingestOnce({
      accountEmail: 'a@b.com',
      config,
      gmailClient: new ProvenanceGmail() as any,
      cursorStore: store,
      metrics: new NoopMetrics(),
      onMessage: async (m) => {
        captured = m;
      }
    });

    expect(captured.provenance.message.messageId).toBe('m2');
    expect(captured.provenance.preExtractionArtifacts.some((artifact: any) => artifact.origin.gmailAttachmentId === 'att-m2')).toBe(true);
    expect(captured.attachments[0].attachmentId).toBe('att-m2');
  });

});
