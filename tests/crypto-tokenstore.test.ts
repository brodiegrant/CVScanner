import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteTokenStore, decryptString, encryptString, validateAndDecodeKey } from '../src/storage/sqlite/sqliteTokenStore.js';

describe('aes-gcm helpers', () => {
  it('encrypt/decrypt roundtrip', () => {
    const key = Buffer.from('a'.repeat(32));
    const enc = encryptString('secret', key);
    expect(decryptString(enc, key)).toBe('secret');
  });

  it('rejects invalid key length', () => {
    expect(() => validateAndDecodeKey(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('SqliteTokenStore', () => {
  it('supports CRUD and token update (refresh behavior)', () => {
    const dbPath = path.join(os.tmpdir(), `cvscanner-${Date.now()}.db`);
    const key = Buffer.alloc(32, 9).toString('base64');
    const store = new SqliteTokenStore(dbPath, key);

    store.upsert({ accountEmail: 'a@b.com', accessToken: 'a1', refreshToken: 'r1', expiryDate: 100 });
    expect(store.get('a@b.com')).toEqual({ accountEmail: 'a@b.com', accessToken: 'a1', refreshToken: 'r1', expiryDate: 100 });

    store.upsert({ accountEmail: 'a@b.com', accessToken: 'a2', refreshToken: 'r1', expiryDate: 200 });
    expect(store.get('a@b.com')).toEqual({ accountEmail: 'a@b.com', accessToken: 'a2', refreshToken: 'r1', expiryDate: 200 });
  });
});
