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

  it('updates access token without refreshToken and preserves refresh ciphertext fields', () => {
    const dbPath = path.join(os.tmpdir(), `cvscanner-${Date.now()}-preserve.db`);
    const key = Buffer.alloc(32, 9).toString('base64');
    const store = new SqliteTokenStore(dbPath, key);

    store.upsert({ accountEmail: 'a@b.com', accessToken: 'a1', refreshToken: 'r1', expiryDate: 100 });

    store.mergeUpsert('a@b.com', { accessToken: 'a2', expiryDate: 200 });
    expect(store.get('a@b.com')).toEqual({ accountEmail: 'a@b.com', accessToken: 'a2', refreshToken: 'r1', expiryDate: 200 });
  });

  it('replaces refresh token material when refreshToken is provided', () => {
    const dbPath = path.join(os.tmpdir(), `cvscanner-${Date.now()}-rotate.db`);
    const key = Buffer.alloc(32, 9).toString('base64');
    const store = new SqliteTokenStore(dbPath, key);

    store.upsert({ accountEmail: 'a@b.com', accessToken: 'a1', refreshToken: 'r1', expiryDate: 100 });

    store.mergeUpsert('a@b.com', { accessToken: 'a2', refreshToken: 'r2', expiryDate: 200 });
    expect(store.get('a@b.com')).toEqual({ accountEmail: 'a@b.com', accessToken: 'a2', refreshToken: 'r2', expiryDate: 200 });
  });

  it('throws when mergeUpsert without refreshToken is used for a new row', () => {
    const dbPath = path.join(os.tmpdir(), `cvscanner-${Date.now()}-new-row.db`);
    const key = Buffer.alloc(32, 9).toString('base64');
    const store = new SqliteTokenStore(dbPath, key);

    expect(() => {
      store.mergeUpsert('new@b.com', { accessToken: 'a1', expiryDate: 100 });
    }).toThrow(/requires refreshToken when creating a new token row/);
  });
});
