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

  it('keeps refresh token when merge omits it and updates when present', () => {
    const dbPath = path.join(os.tmpdir(), `cvscanner-${Date.now()}-merge.db`);
    const key = Buffer.alloc(32, 8).toString('base64');
    const store = new SqliteTokenStore(dbPath, key);

    store.upsert({ accountEmail: 'merge@test.com', accessToken: 'a1', refreshToken: 'r1', expiryDate: 100 });
    store.merge('merge@test.com', { accessToken: 'a2', expiryDate: 200 });
    expect(store.get('merge@test.com')).toEqual({ accountEmail: 'merge@test.com', accessToken: 'a2', refreshToken: 'r1', expiryDate: 200 });

    store.merge('merge@test.com', { accessToken: 'a3', refreshToken: 'r2', expiryDate: 300 });
    expect(store.get('merge@test.com')).toEqual({ accountEmail: 'merge@test.com', accessToken: 'a3', refreshToken: 'r2', expiryDate: 300 });

    store.merge('merge@test.com', { accessToken: 'a4', refreshToken: '', expiryDate: 400 });
    expect(store.get('merge@test.com')).toEqual({ accountEmail: 'merge@test.com', accessToken: 'a4', refreshToken: 'r2', expiryDate: 400 });
  });

  it('is safe when a rotated refresh token races with updates that omit refresh_token', async () => {
    const dbPath = path.join(os.tmpdir(), `cvscanner-${Date.now()}-race.db`);
    const key = Buffer.alloc(32, 7).toString('base64');
    const store = new SqliteTokenStore(dbPath, key);

    store.upsert({ accountEmail: 'race@test.com', accessToken: 'a0', refreshToken: 'r1', expiryDate: 1 });

    await Promise.all([
      Promise.resolve().then(() => store.merge('race@test.com', { accessToken: 'a1', refreshToken: 'r2', expiryDate: 2 })),
      Promise.resolve().then(() => store.merge('race@test.com', { accessToken: 'a2', expiryDate: 3 })),
      Promise.resolve().then(() => store.merge('race@test.com', { accessToken: 'a3', refreshToken: '', expiryDate: 4 }))
    ]);

    expect(store.get('race@test.com')?.refreshToken).toBe('r2');
  });
});
