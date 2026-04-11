import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SqliteExtractionStore } from '../src/storage/sqlite/sqliteExtractionStore.js';

describe('SqliteExtractionStore', () => {
  it('stores one extraction row per attempt and returns the latest row by key', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-store-'));
    const dbPath = path.join(tmp, 'state.sqlite3');
    const store = new SqliteExtractionStore(dbPath);

    store.insertExtractionAttempt({
      extractionKey: 'm-1',
      status: 'parsed',
      rawModelOutput: '{"tags":["signal:strong"]}',
      parsedTagExplanationJson: '{"tags":["signal:strong"]}',
      rejectionReason: null,
      modelName: 'model-a',
      promptVersion: 'v1',
      errorDetails: null
    });

    store.insertExtractionAttempt({
      extractionKey: 'm-1',
      status: 'error',
      rawModelOutput: '{"error":true}',
      parsedTagExplanationJson: null,
      rejectionReason: null,
      modelName: 'model-a',
      promptVersion: 'v1',
      errorDetails: '{"message":"timeout"}'
    });

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT * FROM extractions WHERE extraction_key = ? ORDER BY id ASC').all('m-1') as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe('parsed');
    expect(rows[1]?.status).toBe('error');

    const latest = store.getLatestByExtractionKey('m-1');
    expect(latest?.status).toBe('error');
    expect(latest?.errorDetails).toContain('timeout');
  });
});
