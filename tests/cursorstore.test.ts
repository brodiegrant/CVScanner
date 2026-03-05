import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteCursorStore } from '../src/storage/sqlite/sqliteCursorStore.js';

describe('SqliteCursorStore', () => {
  it('stores watermark and dedupes messages in window', () => {
    const dbPath = path.join(os.tmpdir(), `cvscanner-cursor-${Date.now()}.db`);
    const store = new SqliteCursorStore(dbPath);
    store.setCursor('x@y.com', 'Process', 123);
    expect(store.getCursor('x@y.com', 'Process')?.lastSuccessInternalDate).toBe(123);

    store.markProcessed('x@y.com', 'Process', 'm1', 123);
    expect(store.isProcessed('x@y.com', 'Process', 'm1', 14)).toBe(true);
    expect(store.isProcessed('x@y.com', 'Process', 'm2', 14)).toBe(false);
  });
});
