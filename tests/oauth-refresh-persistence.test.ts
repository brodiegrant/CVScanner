import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAuthorizedClient } from '../src/gmail/oauth/oauthClient.js';
import { SqliteTokenStore } from '../src/storage/sqlite/sqliteTokenStore.js';
import type { AppConfig } from '../src/config/config.js';

const testConfig: AppConfig = {
  oauth: {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectHost: '127.0.0.1',
    redirectPort: 53682
  },
  tokenEncKey: '',
  sqlitePath: '',
  metricsJsonlPath: '',
  defaultLabel: 'Process',
  allowedAttachmentExtensions: ['pdf'],
  dedupeLookbackDays: 14,
  logLevel: 'info',
  metricsEnabled: true,
  ingestBodyMaxChars: 12000,
  ingestIncludeBody: true
};

function createStore() {
  const dbPath = path.join(os.tmpdir(), `cvscanner-oauth-${randomUUID()}.db`);
  const key = Buffer.alloc(32, 7).toString('base64');
  return new SqliteTokenStore(dbPath, key);
}

describe('OAuth token refresh persistence', () => {
  it('persists a rotated refresh token from token events', () => {
    const store = createStore();
    const accountEmail = 'rotated@example.com';
    store.upsert({ accountEmail, accessToken: 'a1', refreshToken: 'r1', expiryDate: 100 });

    const client = createAuthorizedClient(testConfig, store, accountEmail);
    client.emit('tokens', { access_token: 'a2', refresh_token: 'r2', expiry_date: 200 });

    const saved = store.get(accountEmail);
    expect(saved?.refreshToken).toBe('r2');
    expect(saved?.accessToken).toBe('a2');
    expect(saved?.expiryDate).toBe(200);
  });

  it('does not overwrite refresh token when token events omit refresh_token', () => {
    const store = createStore();
    const accountEmail = 'omitted@example.com';
    store.upsert({ accountEmail, accessToken: 'a1', refreshToken: 'r1', expiryDate: 100 });

    const client = createAuthorizedClient(testConfig, store, accountEmail);
    client.emit('tokens', { access_token: 'a2', expiry_date: 200 });

    const saved = store.get(accountEmail);
    expect(saved?.refreshToken).toBe('r1');
    expect(saved?.accessToken).toBe('a2');
    expect(saved?.expiryDate).toBe(200);
  });

  it('does not overwrite refresh token when token events include an empty refresh_token', () => {
    const store = createStore();
    const accountEmail = 'empty@example.com';
    store.upsert({ accountEmail, accessToken: 'a1', refreshToken: 'r1', expiryDate: 100 });

    const client = createAuthorizedClient(testConfig, store, accountEmail);
    client.emit('tokens', { access_token: 'a2', refresh_token: '', expiry_date: 200 });

    const saved = store.get(accountEmail);
    expect(saved?.refreshToken).toBe('r1');
    expect(saved?.accessToken).toBe('a2');
    expect(saved?.expiryDate).toBe(200);
  });

  it('keeps rotated refresh token when later events omit refresh_token', () => {
    const store = createStore();
    const accountEmail = 'rotate-then-omit@example.com';
    store.upsert({ accountEmail, accessToken: 'a1', refreshToken: 'r1', expiryDate: 100 });

    const client = createAuthorizedClient(testConfig, store, accountEmail);
    client.emit('tokens', { access_token: 'a2', refresh_token: 'r2', expiry_date: 200 });
    client.emit('tokens', { access_token: 'a3', expiry_date: 300 });

    const saved = store.get(accountEmail);
    expect(saved?.refreshToken).toBe('r2');
    expect(saved?.accessToken).toBe('a3');
    expect(saved?.expiryDate).toBe(300);
  });
});
