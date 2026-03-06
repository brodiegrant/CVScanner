import { describe, expect, it } from 'vitest';
import { createAuthorizedClient } from '../src/gmail/oauth/oauthClient.js';
import { AppConfig } from '../src/config/config.js';
import { StoredToken, TokenStore, TokenUpdate } from '../src/storage/tokenStore.js';

class InMemoryTokenStore implements TokenStore {
  private readonly map = new Map<string, StoredToken>();

  upsert(token: StoredToken): void {
    this.map.set(token.accountEmail, { ...token });
  }

  merge(accountEmail: string, update: TokenUpdate): void {
    const current = this.map.get(accountEmail);
    if (!current) throw new Error(`No stored token for account ${accountEmail}`);

    const refreshToken = typeof update.refreshToken === 'string' && update.refreshToken.length > 0
      ? update.refreshToken
      : current.refreshToken;

    this.map.set(accountEmail, {
      accountEmail,
      accessToken: update.accessToken ?? current.accessToken,
      refreshToken,
      expiryDate: update.expiryDate ?? current.expiryDate
    });
  }

  get(accountEmail: string): StoredToken | null {
    return this.map.get(accountEmail) ?? null;
  }
}

const config: AppConfig = {
  oauth: { clientId: 'id', clientSecret: 'secret', redirectHost: '127.0.0.1', redirectPort: 5555 },
  tokenEncKey: 'unused',
  sqlitePath: 'unused',
  metricsJsonlPath: 'unused',
  defaultLabel: 'Process',
  allowedAttachmentExtensions: ['pdf'],
  dedupeLookbackDays: 7,
  logLevel: 'info',
  metricsEnabled: false,
  ingestBodyMaxChars: 1000,
  ingestIncludeBody: true
};

describe('OAuth token refresh persistence', () => {
  it('preserves rotated refresh token when later token events omit refresh_token', () => {
    const store = new InMemoryTokenStore();
    store.upsert({ accountEmail: 'acct@test.com', accessToken: 'a0', refreshToken: 'r1', expiryDate: 1 });

    const auth = createAuthorizedClient(config, store, 'acct@test.com');

    (auth as any).emit('tokens', { access_token: 'a1', refresh_token: 'r2', expiry_date: 2 });
    (auth as any).emit('tokens', { access_token: 'a2', expiry_date: 3 });

    expect(store.get('acct@test.com')).toEqual({
      accountEmail: 'acct@test.com',
      accessToken: 'a2',
      refreshToken: 'r2',
      expiryDate: 3
    });
  });

  it('updates refresh token when provider supplies a new one', () => {
    const store = new InMemoryTokenStore();
    store.upsert({ accountEmail: 'acct2@test.com', accessToken: 'a0', refreshToken: 'r1', expiryDate: 1 });

    const auth = createAuthorizedClient(config, store, 'acct2@test.com');
    (auth as any).emit('tokens', { access_token: 'a1', refresh_token: 'r-new', expiry_date: 2 });

    expect(store.get('acct2@test.com')?.refreshToken).toBe('r-new');
  });

  it('never overwrites refresh token with empty values', () => {
    const store = new InMemoryTokenStore();
    store.upsert({ accountEmail: 'acct3@test.com', accessToken: 'a0', refreshToken: 'r1', expiryDate: 1 });

    const auth = createAuthorizedClient(config, store, 'acct3@test.com');
    (auth as any).emit('tokens', { access_token: 'a1', refresh_token: '', expiry_date: 2 });
    (auth as any).emit('tokens', { access_token: 'a2', refresh_token: undefined, expiry_date: 3 });

    expect(store.get('acct3@test.com')?.refreshToken).toBe('r1');
  });
});
