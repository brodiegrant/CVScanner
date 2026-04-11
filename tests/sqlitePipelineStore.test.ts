import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SqlitePipelineStore } from '../src/storage/sqlite/sqlitePipelineStore.js';

describe('SqlitePipelineStore', () => {
  it('creates and upserts candidate extraction, sync attempts, and manual review rows', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-store-'));
    const dbPath = path.join(tmp, 'state.sqlite3');
    const store = new SqlitePipelineStore(dbPath);

    store.upsertCandidateExtraction({
      accountEmail: 'acct@example.com',
      messageId: 'm-1',
      contentHash: 'abc123',
      status: 'parsed',
      rawModelOutput: '{"tags":[]}',
      parsedJson: '{"tags":["signal:strong"]}',
      rejectionReason: null,
      modelName: 'test-model',
      promptVersion: 'v1'
    });

    store.insertVincereSyncAttempt({
      messageId: 'm-1',
      candidateIdentifier: 'acct@example.com',
      matchOutcome: 'no_match',
      matchedCandidateId: null,
      tagsProposed: '["signal:strong"]',
      tagsApplied: '[]',
      resultStatus: 'skipped',
      errorText: null
    });

    store.upsertManualReviewQueue({
      reason: 'low_tag_count',
      messageId: 'm-1',
      candidateHints: '{"from":"acct@example.com"}',
      payloadSnapshot: '{"step":"sync"}'
    });

    const db = new Database(dbPath, { readonly: true });
    const extraction = db.prepare('SELECT * FROM candidate_extractions WHERE account_email = ? AND message_id = ?').get('acct@example.com', 'm-1') as any;
    expect(extraction.status).toBe('parsed');

    const attempt = db.prepare('SELECT * FROM vincere_sync_attempts WHERE message_id = ?').get('m-1') as any;
    expect(attempt.match_outcome).toBe('no_match');
    expect(attempt.result_status).toBe('skipped');

    const review = db.prepare('SELECT * FROM manual_review_queue WHERE reason = ? AND message_id = ?').get('low_tag_count', 'm-1') as any;
    expect(review.candidate_hints).toContain('acct@example.com');

    const queue = store.listManualReviewQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.messageId).toBe('m-1');

    const extractionSnapshot = store.getLatestExtractionByMessageId('m-1');
    expect(extractionSnapshot?.status).toBe('parsed');

    const updatedRows = store.resolveManualReviewByMessageId('m-1', {
      decision: 'approved',
      notes: 'reviewed by test'
    });
    expect(updatedRows).toBe(1);

    const resolved = store.getManualReviewByMessageId('m-1')[0];
    expect(resolved?.payloadSnapshot).toContain('\"resolution\"');
  });
});
