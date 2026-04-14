import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { SqlitePipelineStore } from '../src/storage/sqlite/sqlitePipelineStore.js';
import { runExtractionService, type LlmClient } from '../src/pipeline/extraction/service.js';
import { parseExtractionResult } from '../src/pipeline/extractionResult.js';
import { VincereClient } from '../src/vincere/client.js';

type Message = {
  messageId: string;
  from: string;
  screeningSourceText: string;
  contentHash?: string;
  attachmentName?: string;
};

type RunResult = {
  processed: string[];
  errors: Array<{ messageId: string; error: string }>;
};

afterEach(() => {
  nock.cleanAll();
});

class FakeLlmClient implements LlmClient {
  constructor(private readonly byMessageId: Record<string, { rawOutput: string; modelName: string }>) {}

  async generate(prompt: string): Promise<{ rawOutput: string; modelName: string }> {
    const marker = 'message_id:';
    const idx = prompt.indexOf(marker);
    if (idx < 0) throw new Error('Missing message id marker in prompt');
    const messageId = prompt.slice(idx + marker.length).trim().split(/\s+/)[0] ?? '';
    const next = this.byMessageId[messageId];
    if (!next) throw new Error(`No mocked LLM response for ${messageId}`);
    return next;
  }
}

async function runPipeline(opts: {
  accountEmail: string;
  store: SqlitePipelineStore;
  llmClient: LlmClient;
  vincereClient: VincereClient;
  messages: Message[];
}): Promise<RunResult> {
  const processed: string[] = [];
  const errors: Array<{ messageId: string; error: string }> = [];

  for (const msg of opts.messages) {
    try {
      const extraction = await runExtractionService(`${msg.screeningSourceText}\nmessage_id:${msg.messageId}`, opts.llmClient);

      let parsed: ReturnType<typeof parseExtractionResult>;
      try {
        parsed = parseExtractionResult(JSON.parse(extraction.rawOutput));
      } catch (err) {
        opts.store.upsertCandidateExtraction({
          accountEmail: opts.accountEmail,
          messageId: msg.messageId,
          contentHash: msg.contentHash ?? null,
          status: 'error',
          rawModelOutput: extraction.rawOutput,
          parsedJson: null,
          rejectionReason: err instanceof Error ? err.message : String(err),
          modelName: extraction.modelName,
          promptVersion: extraction.promptVersion
        });
        opts.store.upsertManualReviewQueue({
          reason: 'sync_error',
          messageId: msg.messageId,
          candidateHints: JSON.stringify({ from: msg.from }),
          payloadSnapshot: JSON.stringify({ stage: 'extraction_parse', quarantined: true, rawModelOutput: extraction.rawOutput })
        });
        errors.push({ messageId: msg.messageId, error: 'invalid_llm_output' });
        continue;
      }

      const isReject = parsed.tags.includes('tier:reject');
      opts.store.upsertCandidateExtraction({
        accountEmail: opts.accountEmail,
        messageId: msg.messageId,
        contentHash: msg.contentHash ?? null,
        status: isReject ? 'rejected' : 'parsed',
        rawModelOutput: extraction.rawOutput,
        parsedJson: JSON.stringify(parsed),
        rejectionReason: isReject ? 'tier:reject emitted' : null,
        modelName: extraction.modelName,
        promptVersion: extraction.promptVersion
      });

      if (isReject) {
        opts.store.upsertManualReviewQueue({
          reason: 'low_tag_count',
          messageId: msg.messageId,
          candidateHints: JSON.stringify({ from: msg.from }),
          payloadSnapshot: JSON.stringify({ stage: 'reject_output', quarantined: true })
        });
        opts.store.insertVincereSyncAttempt({
          messageId: msg.messageId,
          candidateIdentifier: msg.from,
          matchOutcome: 'no_match',
          matchedCandidateId: null,
          tagsProposed: JSON.stringify(parsed.tags),
          tagsApplied: JSON.stringify([]),
          resultStatus: 'skipped',
          errorText: 'Rejected extraction routed to manual review'
        });
        processed.push(msg.messageId);
        continue;
      }

      let matchOutcome: 'matched' | 'no_match' | 'ambiguous' = 'no_match';
      let matchedCandidateId: string | null = null;

      try {
        const existing = await opts.vincereClient.get<{ items: Array<{ id: string }> }>(`/api/candidate/search?email=${encodeURIComponent(msg.from)}`);
        const candidateId = existing.items[0]?.id;

        let resolvedCandidateId = candidateId;
        if (resolvedCandidateId) {
          matchOutcome = 'matched';
          matchedCandidateId = resolvedCandidateId;
        } else {
          const created = await opts.vincereClient.post<{ id: string }>('/api/candidate', {
            email: msg.from,
            sourceMessageId: msg.messageId
          });
          resolvedCandidateId = created.id;
        }

        await opts.vincereClient.post(`/api/candidate/${encodeURIComponent(resolvedCandidateId)}/expertise`, {
          tags: parsed.tags
        });
        await opts.vincereClient.post(`/api/candidate/${encodeURIComponent(resolvedCandidateId)}/document`, {
          filename: msg.attachmentName ?? `${msg.messageId}.pdf`
        });

        opts.store.insertVincereSyncAttempt({
          messageId: msg.messageId,
          candidateIdentifier: msg.from,
          matchOutcome,
          matchedCandidateId,
          tagsProposed: JSON.stringify(parsed.tags),
          tagsApplied: JSON.stringify(parsed.tags),
          resultStatus: 'success',
          errorText: null
        });
        processed.push(msg.messageId);
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        opts.store.insertVincereSyncAttempt({
          messageId: msg.messageId,
          candidateIdentifier: msg.from,
          matchOutcome,
          matchedCandidateId,
          tagsProposed: JSON.stringify(parsed.tags),
          tagsApplied: JSON.stringify([]),
          resultStatus: 'error',
          errorText
        });
        opts.store.upsertManualReviewQueue({
          reason: 'sync_error',
          messageId: msg.messageId,
          candidateHints: JSON.stringify({ from: msg.from }),
          payloadSnapshot: JSON.stringify({ stage: 'vincere_sync', quarantined: true, errorText })
        });
        errors.push({ messageId: msg.messageId, error: errorText });
      }
    } catch (err) {
      errors.push({ messageId: msg.messageId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { processed, errors };
}

function newDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-vincere-tests-'));
  const dbPath = path.join(tmp, 'state.sqlite3');
  return { dbPath, store: new SqlitePipelineStore(dbPath) };
}

function rows(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  return {
    extractionByMessageId: (messageId: string) => db.prepare('SELECT * FROM candidate_extractions WHERE message_id = ?').get(messageId) as any,
    syncAttemptsByMessageId: (messageId: string) => db.prepare('SELECT * FROM vincere_sync_attempts WHERE message_id = ? ORDER BY id ASC').all(messageId) as any[],
    manualQueueByMessageId: (messageId: string) => db.prepare('SELECT * FROM manual_review_queue WHERE message_id = ? ORDER BY reason ASC').all(messageId) as any[]
  };
}

const validParsedOutput = JSON.stringify({
  tags: ['tier:t2', 'signal:strong', 'location:global_remote'],
  explanations: {
    'tier:t2': 'Strong senior profile and clear achievements.',
    'signal:strong': 'Evidence is clear and recent across multiple roles.',
    'location:global_remote': 'Explicitly open to global remote opportunities.'
  },
  location: null,
  promptVersion: 'v1',
  modelName: 'mock-llm'
});

describe('LLM extraction + Vincere sync flow', () => {
  it('persists parsed extraction for valid LLM output', async () => {
    const { dbPath, store } = newDb();
    nock('https://vincere.test').get('/api/candidate/search').query(true).reply(200, { items: [{ id: 'cand-1' }] });
    nock('https://vincere.test').post('/api/candidate/cand-1/expertise').reply(200, { ok: true });
    nock('https://vincere.test').post('/api/candidate/cand-1/document').reply(200, { ok: true });

    const llmClient = new FakeLlmClient({
      m1: { rawOutput: validParsedOutput, modelName: 'mock-llm' }
    });

    const result = await runPipeline({
      accountEmail: 'acct@example.com',
      store,
      llmClient,
      vincereClient: new VincereClient({ apiBaseUrl: 'https://vincere.test', apiKey: 'k', idToken: 't' }),
      messages: [{ messageId: 'm1', from: 'candidate@example.com', screeningSourceText: 'CV text' }]
    });

    expect(result.errors).toEqual([]);
    const q = rows(dbPath);
    expect(q.extractionByMessageId('m1').status).toBe('parsed');
    expect(q.syncAttemptsByMessageId('m1')[0]?.result_status).toBe('success');
    expect(q.manualQueueByMessageId('m1')).toHaveLength(0);
  });

  it('marks invalid LLM output as error, queues manual review, and continues run', async () => {
    const { dbPath, store } = newDb();
    nock('https://vincere.test').get('/api/candidate/search').query(true).reply(200, { items: [{ id: 'cand-1' }] });
    nock('https://vincere.test').post('/api/candidate/cand-1/expertise').reply(200, { ok: true });
    nock('https://vincere.test').post('/api/candidate/cand-1/document').reply(200, { ok: true });

    const llmClient = new FakeLlmClient({
      'm-invalid': { rawOutput: '{"tags": ["not-a-valid-tag"]}', modelName: 'mock-llm' },
      'm-ok': { rawOutput: validParsedOutput, modelName: 'mock-llm' }
    });

    const result = await runPipeline({
      accountEmail: 'acct@example.com',
      store,
      llmClient,
      vincereClient: new VincereClient({ apiBaseUrl: 'https://vincere.test', apiKey: 'k', idToken: 't' }),
      messages: [
        { messageId: 'm-invalid', from: 'invalid@example.com', screeningSourceText: 'bad CV' },
        { messageId: 'm-ok', from: 'candidate@example.com', screeningSourceText: 'good CV' }
      ]
    });

    expect(result.processed).toEqual(['m-ok']);
    expect(result.errors).toHaveLength(1);

    const q = rows(dbPath);
    expect(q.extractionByMessageId('m-invalid').status).toBe('error');
    expect(q.manualQueueByMessageId('m-invalid')).toHaveLength(1);
    expect(q.extractionByMessageId('m-ok').status).toBe('parsed');
  });

  it('always routes reject output to manual review', async () => {
    const { dbPath, store } = newDb();
    const llmClient = new FakeLlmClient({
      'm-reject': {
        rawOutput: JSON.stringify({
          tags: ['tier:reject'],
          explanations: { 'tier:reject': 'Candidate does not meet minimum requirements.' },
          location: null,
          promptVersion: 'v1',
          modelName: 'mock-llm'
        }),
        modelName: 'mock-llm'
      }
    });

    const result = await runPipeline({
      accountEmail: 'acct@example.com',
      store,
      llmClient,
      vincereClient: new VincereClient({ apiBaseUrl: 'https://vincere.test', apiKey: 'k', idToken: 't' }),
      messages: [{ messageId: 'm-reject', from: 'reject@example.com', screeningSourceText: 'CV' }]
    });

    expect(result.errors).toEqual([]);
    const q = rows(dbPath);
    expect(q.extractionByMessageId('m-reject').status).toBe('rejected');
    expect(q.manualQueueByMessageId('m-reject')).toHaveLength(1);
    expect(q.syncAttemptsByMessageId('m-reject')[0]?.result_status).toBe('skipped');
  });

  it('follows create -> expertise link -> document upload when candidate is missing', async () => {
    const { dbPath, store } = newDb();
    const calls: string[] = [];

    nock('https://vincere.test')
      .get('/api/candidate/search')
      .query(true)
      .reply(() => {
        calls.push('search');
        return [200, { items: [] }];
      });

    nock('https://vincere.test')
      .post('/api/candidate')
      .reply(() => {
        calls.push('create');
        return [200, { id: 'cand-created' }];
      });

    nock('https://vincere.test')
      .post('/api/candidate/cand-created/expertise')
      .reply(() => {
        calls.push('expertise');
        return [200, { ok: true }];
      });

    nock('https://vincere.test')
      .post('/api/candidate/cand-created/document')
      .reply(() => {
        calls.push('document');
        return [200, { ok: true }];
      });

    const llmClient = new FakeLlmClient({
      'm-create': { rawOutput: validParsedOutput, modelName: 'mock-llm' }
    });

    await runPipeline({
      accountEmail: 'acct@example.com',
      store,
      llmClient,
      vincereClient: new VincereClient({ apiBaseUrl: 'https://vincere.test', apiKey: 'k', idToken: 't' }),
      messages: [{ messageId: 'm-create', from: 'new@example.com', screeningSourceText: 'CV' }]
    });

    expect(calls).toEqual(['search', 'create', 'expertise', 'document']);
    const q = rows(dbPath);
    expect(q.syncAttemptsByMessageId('m-create')[0]?.match_outcome).toBe('no_match');
  });

  it('follows expertise link -> document upload when candidate already exists', async () => {
    const { dbPath, store } = newDb();
    const calls: string[] = [];

    nock('https://vincere.test')
      .get('/api/candidate/search')
      .query(true)
      .reply(() => {
        calls.push('search');
        return [200, { items: [{ id: 'cand-existing' }] }];
      });

    nock('https://vincere.test')
      .post('/api/candidate/cand-existing/expertise')
      .reply(() => {
        calls.push('expertise');
        return [200, { ok: true }];
      });

    nock('https://vincere.test')
      .post('/api/candidate/cand-existing/document')
      .reply(() => {
        calls.push('document');
        return [200, { ok: true }];
      });

    const llmClient = new FakeLlmClient({
      'm-existing': { rawOutput: validParsedOutput, modelName: 'mock-llm' }
    });

    await runPipeline({
      accountEmail: 'acct@example.com',
      store,
      llmClient,
      vincereClient: new VincereClient({ apiBaseUrl: 'https://vincere.test', apiKey: 'k', idToken: 't' }),
      messages: [{ messageId: 'm-existing', from: 'existing@example.com', screeningSourceText: 'CV' }]
    });

    expect(calls).toEqual(['search', 'expertise', 'document']);
    const q = rows(dbPath);
    expect(q.syncAttemptsByMessageId('m-existing')[0]?.match_outcome).toBe('matched');
  });

  it('quarantines sync/upload failures, persists error, and continues the run', async () => {
    const { dbPath, store } = newDb();

    nock('https://vincere.test')
      .get('/api/candidate/search')
      .query((q) => (q.email as string) === 'fail@example.com')
      .reply(200, { items: [{ id: 'cand-fail' }] });

    nock('https://vincere.test')
      .post('/api/candidate/cand-fail/expertise')
      .reply(500, { error: 'downstream failure' });

    nock('https://vincere.test')
      .get('/api/candidate/search')
      .query((q) => (q.email as string) === 'ok@example.com')
      .reply(200, { items: [{ id: 'cand-ok' }] });

    nock('https://vincere.test')
      .post('/api/candidate/cand-ok/expertise')
      .reply(200, { ok: true });

    nock('https://vincere.test')
      .post('/api/candidate/cand-ok/document')
      .reply(200, { ok: true });

    const llmClient = new FakeLlmClient({
      'm-fail': { rawOutput: validParsedOutput, modelName: 'mock-llm' },
      'm-ok': { rawOutput: validParsedOutput, modelName: 'mock-llm' }
    });

    const result = await runPipeline({
      accountEmail: 'acct@example.com',
      store,
      llmClient,
      vincereClient: new VincereClient({ apiBaseUrl: 'https://vincere.test', apiKey: 'k', idToken: 't' }),
      messages: [
        { messageId: 'm-fail', from: 'fail@example.com', screeningSourceText: 'CV' },
        { messageId: 'm-ok', from: 'ok@example.com', screeningSourceText: 'CV' }
      ]
    });

    expect(result.processed).toEqual(['m-ok']);
    expect(result.errors).toHaveLength(1);

    const q = rows(dbPath);
    expect(q.syncAttemptsByMessageId('m-fail')[0]?.result_status).toBe('error');
    expect(q.syncAttemptsByMessageId('m-fail')[0]?.error_text).toContain('Vincere API request failed');
    expect(q.manualQueueByMessageId('m-fail')[0]?.reason).toBe('sync_error');
    expect(q.manualQueueByMessageId('m-fail')[0]?.payload_snapshot).toContain('"quarantined":true');

    expect(q.syncAttemptsByMessageId('m-ok')[0]?.result_status).toBe('success');
  });
});
