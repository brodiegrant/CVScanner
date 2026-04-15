import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';
import { ingestOnce, type IngestForLlm } from '../src/gmail/ingest/ingestService.js';
import { runExtractionService, type LlmClient } from '../src/pipeline/extraction/service.js';
import { parseExtractionResult } from '../src/pipeline/extractionResult.js';
import { NoopMetrics } from '../src/observability/metrics.js';
import { SqliteCursorStore } from '../src/storage/sqlite/sqliteCursorStore.js';
import { SqlitePipelineStore } from '../src/storage/sqlite/sqlitePipelineStore.js';
import { VincereClient } from '../src/vincere/client.js';

type TestMessage = {
  messageId: string;
  internalDate: number;
  from: string;
  screeningSourceText: string;
  attachmentName?: string;
};

type FlowResult = {
  processed: string[];
  errors: Array<{ messageId: string; error: string }>;
};

const config = {
  defaultLabel: 'Process',
  dedupeLookbackDays: 14,
  logLevel: 'info',
  maxAttachmentBytes: 10 * 1024 * 1024,
  allowedAttachmentMimeTypes: ['application/pdf'],
  allowedAttachmentExtensions: ['pdf'],
  allowAttachmentArchives: false,
  maxArchiveExpansionRatio: 30,
  ingestBodyMaxChars: 2000,
  ingestIncludeBody: true
} as const;

class FakeGmailClient {
  constructor(private readonly messages: TestMessage[]) {}

  async listMessageIds() {
    return this.messages.map((m) => m.messageId);
  }

  async getMessageMetadata(id: string) {
    const msg = this.messages.find((m) => m.messageId === id);
    if (!msg) {
      throw new Error(`Missing metadata for ${id}`);
    }

    return {
      messageId: msg.messageId,
      threadId: `thread-${msg.messageId}`,
      internalDate: msg.internalDate,
      from: msg.from,
      normalizedBodyCandidate: msg.screeningSourceText,
      bodyExtractionSource: 'text/plain' as const
    };
  }

  async getAttachments(id: string, _policy?: unknown, downloadBytes?: boolean) {
    const msg = this.messages.find((m) => m.messageId === id);
    if (!msg) {
      throw new Error(`Missing attachment for ${id}`);
    }

    return [
      {
        attachmentId: `att-${msg.messageId}`,
        filename: msg.attachmentName ?? `${msg.messageId}.pdf`,
        mimeType: 'application/pdf',
        size: 10,
        data: downloadBytes ? Buffer.from('pdf-bits') : undefined,
        rejected: false
      }
    ];
  }
}

class FakeLlmClient implements LlmClient {
  constructor(private readonly byMessageId: Record<string, { rawOutput: string; modelName: string }>) {}

  async generate(prompt: string): Promise<{ rawOutput: string; modelName: string }> {
    const marker = 'message_id:';
    const idx = prompt.indexOf(marker);
    const messageId = idx >= 0 ? prompt.slice(idx + marker.length).trim().split(/\s+/)[0] ?? '' : '';
    const response = this.byMessageId[messageId];
    if (!response) {
      throw new Error(`No mocked LLM output for ${messageId}`);
    }

    return response;
  }
}

function newDbPath(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return path.join(tmp, 'state.sqlite3');
}

function queryRows(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  return {
    extractionByMessageId(messageId: string) {
      return db.prepare('SELECT * FROM candidate_extractions WHERE message_id = ?').get(messageId) as any;
    },
    syncAttemptsByMessageId(messageId: string) {
      return db.prepare('SELECT * FROM vincere_sync_attempts WHERE message_id = ? ORDER BY id ASC').all(messageId) as any[];
    },
    manualReviewByMessageId(messageId: string) {
      return db.prepare('SELECT * FROM manual_review_queue WHERE message_id = ? ORDER BY reason ASC').all(messageId) as any[];
    }
  };
}

async function processMessage(opts: {
  accountEmail: string;
  payload: IngestForLlm;
  store: SqlitePipelineStore;
  llmClient: LlmClient;
  vincereClient: VincereClient;
}): Promise<void> {
  const extraction = await runExtractionService(`${opts.payload.screeningSourceText ?? ''}\nmessage_id:${opts.payload.messageId}`, opts.llmClient);

  let parsed: ReturnType<typeof parseExtractionResult>;
  try {
    parsed = parseExtractionResult(JSON.parse(extraction.rawOutput));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    opts.store.upsertCandidateExtraction({
      accountEmail: opts.accountEmail,
      messageId: opts.payload.messageId,
      contentHash: opts.payload.contentHash ?? null,
      status: 'error',
      rawModelOutput: extraction.rawOutput,
      parsedJson: null,
      rejectionReason: reason,
      modelName: extraction.modelName,
      promptVersion: extraction.promptVersion
    });
    opts.store.upsertManualReviewQueue({
      reason: 'extraction_error',
      messageId: opts.payload.messageId,
      candidateHints: JSON.stringify({ from: opts.payload.from }),
      payloadSnapshot: JSON.stringify({ stage: 'extraction_parse', quarantined: true, errorText: reason })
    });
    throw new Error(`extraction_error:${reason}`);
  }

  const isReject = parsed.tags.includes('tier:4');
  opts.store.upsertCandidateExtraction({
    accountEmail: opts.accountEmail,
    messageId: opts.payload.messageId,
    contentHash: opts.payload.contentHash ?? null,
    status: isReject ? 'rejected' : 'parsed',
    rawModelOutput: extraction.rawOutput,
    parsedJson: JSON.stringify(parsed),
    rejectionReason: isReject ? 'tier:4 emitted' : null,
    modelName: extraction.modelName,
    promptVersion: extraction.promptVersion
  });

  if (isReject) {
    opts.store.upsertManualReviewQueue({
      reason: 'low_tag_count',
      messageId: opts.payload.messageId,
      candidateHints: JSON.stringify({ from: opts.payload.from }),
      payloadSnapshot: JSON.stringify({ stage: 'reject_output', quarantined: true })
    });
    opts.store.insertVincereSyncAttempt({
      messageId: opts.payload.messageId,
      candidateIdentifier: opts.payload.from ?? 'unknown',
      matchOutcome: 'no_match',
      matchedCandidateId: null,
      tagsProposed: JSON.stringify(parsed.tags),
      tagsApplied: JSON.stringify([]),
      resultStatus: 'skipped',
      errorText: 'Rejected extraction routed to manual review'
    });
    return;
  }

  let matchOutcome: 'matched' | 'no_match' | 'ambiguous' = 'no_match';
  let matchedCandidateId: string | null = null;

  try {
    const candidate = await opts.vincereClient.get<{ items: Array<{ id: string }> }>(`/api/candidate/search?email=${encodeURIComponent(opts.payload.from ?? '')}`);
    let resolvedCandidateId = candidate.items[0]?.id;
    if (resolvedCandidateId) {
      matchOutcome = 'matched';
      matchedCandidateId = resolvedCandidateId;
    } else {
      const created = await opts.vincereClient.post<{ id: string }>('/api/candidate', {
        email: opts.payload.from,
        sourceMessageId: opts.payload.messageId
      });
      resolvedCandidateId = created.id;
    }

    await opts.vincereClient.post(`/api/candidate/${encodeURIComponent(resolvedCandidateId)}/expertise`, {
      tags: parsed.tags
    });

    await opts.vincereClient.post(`/api/candidate/${encodeURIComponent(resolvedCandidateId)}/document`, {
      filename: opts.payload.attachments[0]?.filename ?? `${opts.payload.messageId}.pdf`
    });

    opts.store.insertVincereSyncAttempt({
      messageId: opts.payload.messageId,
      candidateIdentifier: opts.payload.from ?? 'unknown',
      matchOutcome,
      matchedCandidateId,
      tagsProposed: JSON.stringify(parsed.tags),
      tagsApplied: JSON.stringify(parsed.tags),
      resultStatus: 'success',
      errorText: null
    });
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    opts.store.insertVincereSyncAttempt({
      messageId: opts.payload.messageId,
      candidateIdentifier: opts.payload.from ?? 'unknown',
      matchOutcome,
      matchedCandidateId,
      tagsProposed: JSON.stringify(parsed.tags),
      tagsApplied: JSON.stringify([]),
      resultStatus: 'error',
      errorText
    });
    opts.store.upsertManualReviewQueue({
      reason: 'sync_error',
      messageId: opts.payload.messageId,
      candidateHints: JSON.stringify({ from: opts.payload.from }),
      payloadSnapshot: JSON.stringify({ stage: 'vincere_sync', quarantined: true, errorText })
    });
    throw new Error(`sync_error:${errorText}`);
  }
}

async function runIntegrationFlow(opts: {
  dbPath: string;
  accountEmail: string;
  messages: TestMessage[];
  llmByMessageId: Record<string, { rawOutput: string; modelName: string }>;
}): Promise<FlowResult> {
  const cursorStore = new SqliteCursorStore(opts.dbPath);
  const pipelineStore = new SqlitePipelineStore(opts.dbPath);
  const gmailClient = new FakeGmailClient(opts.messages);
  const llmClient = new FakeLlmClient(opts.llmByMessageId);
  const vincereClient = new VincereClient({ apiBaseUrl: 'https://vincere.test', apiKey: 'k', idToken: 't' });
  const processed: string[] = [];
  const errors: Array<{ messageId: string; error: string }> = [];

  await ingestOnce({
    accountEmail: opts.accountEmail,
    config: config as any,
    gmailClient: gmailClient as any,
    cursorStore,
    metrics: new NoopMetrics(),
    onMessage: async (payload) => {
      try {
        await processMessage({
          accountEmail: opts.accountEmail,
          payload,
          store: pipelineStore,
          llmClient,
          vincereClient
        });
        processed.push(payload.messageId);
      } catch (err) {
        errors.push({
          messageId: payload.messageId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  });

  return { processed, errors };
}

const validOutput = JSON.stringify({
  tags: ['tier:2', 'signal:digital', 'location:global_remote'],
  explanations: {
    'tier:2': 'Strong profile',
    'signal:digital': 'Clear evidence',
    'location:global_remote': 'Remote-ready'
  },
  location: null,
  promptVersion: 'v1',
  modelName: 'mock-llm'
});

afterEach(() => {
  nock.cleanAll();
});

describe('integration-style ingestion + extraction + Vincere persistence', () => {
  it('valid extraction is parsed and syncs with document upload', async () => {
    const dbPath = newDbPath('integration-valid');

    nock('https://vincere.test').get('/api/candidate/search').query(true).reply(200, { items: [{ id: 'cand-1' }] });
    nock('https://vincere.test').post('/api/candidate/cand-1/expertise').reply(200, { ok: true });
    nock('https://vincere.test').post('/api/candidate/cand-1/document').reply(200, { ok: true });

    const result = await runIntegrationFlow({
      dbPath,
      accountEmail: 'acct@example.com',
      messages: [{ messageId: 'm-valid', internalDate: 1000, from: 'valid@example.com', screeningSourceText: 'Valid CV' }],
      llmByMessageId: { 'm-valid': { rawOutput: validOutput, modelName: 'mock-llm' } }
    });

    expect(result.processed).toEqual(['m-valid']);
    expect(result.errors).toEqual([]);

    const q = queryRows(dbPath);
    expect(q.extractionByMessageId('m-valid').status).toBe('parsed');
    expect(q.syncAttemptsByMessageId('m-valid')).toHaveLength(1);
    expect(q.syncAttemptsByMessageId('m-valid')[0]?.result_status).toBe('success');
    expect(q.manualReviewByMessageId('m-valid')).toHaveLength(0);
  });

  it('routes reject extraction to manual review every time', async () => {
    const dbPath = newDbPath('integration-reject');

    const result = await runIntegrationFlow({
      dbPath,
      accountEmail: 'acct@example.com',
      messages: [{ messageId: 'm-reject', internalDate: 1000, from: 'reject@example.com', screeningSourceText: 'Reject CV' }],
      llmByMessageId: {
        'm-reject': {
          rawOutput: JSON.stringify({
            tags: ['tier:4', 'signal:digital', 'location:global_remote'],
            explanations: {
              'tier:4': 'Below required profile quality.',
              'signal:digital': 'Digital-only signal and limited evidence.',
              'location:global_remote': 'Remote preference extracted.'
            },
            location: null,
            promptVersion: 'v1',
            modelName: 'mock-llm'
          }),
          modelName: 'mock-llm'
        }
      }
    });

    expect(result.processed).toEqual(['m-reject']);
    expect(result.errors).toEqual([]);

    const q = queryRows(dbPath);
    expect(q.extractionByMessageId('m-reject').status).toBe('rejected');
    expect(q.syncAttemptsByMessageId('m-reject')).toHaveLength(1);
    expect(q.syncAttemptsByMessageId('m-reject')[0]?.result_status).toBe('skipped');
    expect(q.manualReviewByMessageId('m-reject')).toHaveLength(1);
    expect(q.manualReviewByMessageId('m-reject')[0]?.reason).toBe('low_tag_count');
  });

  it('handles invalid LLM output as extraction error, queues review, and continues run', async () => {
    const dbPath = newDbPath('integration-llm-error');

    nock('https://vincere.test').get('/api/candidate/search').query(true).reply(200, { items: [{ id: 'cand-ok' }] });
    nock('https://vincere.test').post('/api/candidate/cand-ok/expertise').reply(200, { ok: true });
    nock('https://vincere.test').post('/api/candidate/cand-ok/document').reply(200, { ok: true });

    const result = await runIntegrationFlow({
      dbPath,
      accountEmail: 'acct@example.com',
      messages: [
        { messageId: 'm-invalid', internalDate: 1000, from: 'invalid@example.com', screeningSourceText: 'Bad output CV' },
        { messageId: 'm-ok', internalDate: 2000, from: 'ok@example.com', screeningSourceText: 'Good output CV' }
      ],
      llmByMessageId: {
        'm-invalid': { rawOutput: '{"tags":["not_a_real_tag"]}', modelName: 'mock-llm' },
        'm-ok': { rawOutput: validOutput, modelName: 'mock-llm' }
      }
    });

    expect(result.processed).toEqual(['m-ok']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.messageId).toBe('m-invalid');

    const q = queryRows(dbPath);
    expect(q.extractionByMessageId('m-invalid').status).toBe('error');
    expect(q.syncAttemptsByMessageId('m-invalid')).toHaveLength(0);
    expect(q.manualReviewByMessageId('m-invalid')).toHaveLength(1);
    expect(q.manualReviewByMessageId('m-invalid')[0]?.reason).toBe('extraction_error');

    expect(q.extractionByMessageId('m-ok').status).toBe('parsed');
    expect(q.syncAttemptsByMessageId('m-ok')[0]?.result_status).toBe('success');
    expect(q.manualReviewByMessageId('m-ok')).toHaveLength(0);
  });

  it('covers both candidate create and candidate update paths', async () => {
    const dbPath = newDbPath('integration-create-update');

    nock('https://vincere.test')
      .get('/api/candidate/search')
      .query((q) => (q.email as string) === 'new@example.com')
      .reply(200, { items: [] });
    nock('https://vincere.test').post('/api/candidate').reply(200, { id: 'cand-created' });
    nock('https://vincere.test').post('/api/candidate/cand-created/expertise').reply(200, { ok: true });
    nock('https://vincere.test').post('/api/candidate/cand-created/document').reply(200, { ok: true });

    nock('https://vincere.test')
      .get('/api/candidate/search')
      .query((q) => (q.email as string) === 'existing@example.com')
      .reply(200, { items: [{ id: 'cand-existing' }] });
    nock('https://vincere.test').post('/api/candidate/cand-existing/expertise').reply(200, { ok: true });
    nock('https://vincere.test').post('/api/candidate/cand-existing/document').reply(200, { ok: true });

    const result = await runIntegrationFlow({
      dbPath,
      accountEmail: 'acct@example.com',
      messages: [
        { messageId: 'm-create', internalDate: 1000, from: 'new@example.com', screeningSourceText: 'Needs create' },
        { messageId: 'm-update', internalDate: 2000, from: 'existing@example.com', screeningSourceText: 'Needs update' }
      ],
      llmByMessageId: {
        'm-create': { rawOutput: validOutput, modelName: 'mock-llm' },
        'm-update': { rawOutput: validOutput, modelName: 'mock-llm' }
      }
    });

    expect(result.errors).toEqual([]);
    expect(result.processed).toEqual(['m-create', 'm-update']);

    const q = queryRows(dbPath);

    expect(q.extractionByMessageId('m-create').status).toBe('parsed');
    expect(q.syncAttemptsByMessageId('m-create')[0]?.match_outcome).toBe('no_match');
    expect(q.syncAttemptsByMessageId('m-create')[0]?.result_status).toBe('success');
    expect(q.manualReviewByMessageId('m-create')).toHaveLength(0);

    expect(q.extractionByMessageId('m-update').status).toBe('parsed');
    expect(q.syncAttemptsByMessageId('m-update')[0]?.match_outcome).toBe('matched');
    expect(q.syncAttemptsByMessageId('m-update')[0]?.result_status).toBe('success');
    expect(q.manualReviewByMessageId('m-update')).toHaveLength(0);
  });

  it('persists sync/upload failures, queues manual review, and continues run', async () => {
    const dbPath = newDbPath('integration-sync-error');

    nock('https://vincere.test')
      .get('/api/candidate/search')
      .query((q) => (q.email as string) === 'fail@example.com')
      .reply(200, { items: [{ id: 'cand-fail' }] });
    nock('https://vincere.test').post('/api/candidate/cand-fail/expertise').reply(200, { ok: true });
    nock('https://vincere.test').post('/api/candidate/cand-fail/document').reply(500, { error: 'upload failed' });

    nock('https://vincere.test')
      .get('/api/candidate/search')
      .query((q) => (q.email as string) === 'ok@example.com')
      .reply(200, { items: [{ id: 'cand-ok' }] });
    nock('https://vincere.test').post('/api/candidate/cand-ok/expertise').reply(200, { ok: true });
    nock('https://vincere.test').post('/api/candidate/cand-ok/document').reply(200, { ok: true });

    const result = await runIntegrationFlow({
      dbPath,
      accountEmail: 'acct@example.com',
      messages: [
        { messageId: 'm-fail', internalDate: 1000, from: 'fail@example.com', screeningSourceText: 'Failure CV' },
        { messageId: 'm-ok', internalDate: 2000, from: 'ok@example.com', screeningSourceText: 'Success CV' }
      ],
      llmByMessageId: {
        'm-fail': { rawOutput: validOutput, modelName: 'mock-llm' },
        'm-ok': { rawOutput: validOutput, modelName: 'mock-llm' }
      }
    });

    expect(result.processed).toEqual(['m-ok']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.messageId).toBe('m-fail');

    const q = queryRows(dbPath);
    expect(q.extractionByMessageId('m-fail').status).toBe('parsed');
    expect(q.syncAttemptsByMessageId('m-fail')[0]?.result_status).toBe('error');
    expect(q.syncAttemptsByMessageId('m-fail')[0]?.error_text).toContain('Vincere API request failed');
    expect(q.manualReviewByMessageId('m-fail')).toHaveLength(1);
    expect(q.manualReviewByMessageId('m-fail')[0]?.reason).toBe('sync_error');

    expect(q.extractionByMessageId('m-ok').status).toBe('parsed');
    expect(q.syncAttemptsByMessageId('m-ok')[0]?.result_status).toBe('success');
    expect(q.manualReviewByMessageId('m-ok')).toHaveLength(0);
  });
});
