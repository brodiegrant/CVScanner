import { beforeEach, describe, expect, it, vi } from 'vitest';

let latestOAuthState = '';
const waitForOAuthCodeMock = vi.fn();

vi.mock('../src/gmail/oauth/oauthServer.js', () => ({
  waitForOAuthCode: waitForOAuthCodeMock
}));

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        generateAuthUrl(options: { state: string }) {
          latestOAuthState = options.state;
          return 'https://auth.example.test/authorize';
        }

        async getToken() {
          return {
            tokens: {
              access_token: 'access-token',
              refresh_token: 'refresh-token',
              expiry_date: 1234567890
            }
          };
        }

        setCredentials() {}
      }
    },
    gmail: () => ({
      users: {
        getProfile: async () => ({
          data: {
            emailAddress: 'user@example.com'
          }
        })
      }
    })
  }
}));

describe('oauthClient browser launch fallback', () => {
  beforeEach(() => {
    latestOAuthState = '';
    waitForOAuthCodeMock.mockReset();
    vi.restoreAllMocks();
  });

  it('always logs fallback URL guidance', async () => {
    waitForOAuthCodeMock.mockImplementation(async () => ({ code: 'oauth-code', state: latestOAuthState }));
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const { connectAccount } = await import('../src/gmail/oauth/oauthClient.js');

    const tokenStore = {
      upsert: vi.fn(),
      merge: vi.fn(),
      mergeUpsert: vi.fn(),
      get: vi.fn()
    };

    await connectAccount(
      {
        oauth: {
          clientId: 'id',
          clientSecret: 'secret',
          redirectHost: '127.0.0.1',
          redirectPort: 3333
        }
      },
      tokenStore,
      vi.fn().mockResolvedValue(true)
    );

    expect(consoleInfoSpy).toHaveBeenCalledWith('If your browser did not open, visit: https://auth.example.test/authorize');
  });

  it('logs authorization URL when opener fails', async () => {
    waitForOAuthCodeMock.mockImplementation(async () => ({ code: 'oauth-code', state: latestOAuthState }));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const { connectAccount } = await import('../src/gmail/oauth/oauthClient.js');

    const tokenStore = {
      upsert: vi.fn(),
      merge: vi.fn(),
      mergeUpsert: vi.fn(),
      get: vi.fn()
    };

    await connectAccount(
      {
        oauth: {
          clientId: 'id',
          clientSecret: 'secret',
          redirectHost: '127.0.0.1',
          redirectPort: 3333
        }
      },
      tokenStore,
      vi.fn().mockResolvedValue(false)
    );

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Automatic browser launch failed. Authorization URL: https://auth.example.test/authorize')
    );
    expect(consoleInfoSpy).toHaveBeenCalledWith('If your browser did not open, visit: https://auth.example.test/authorize');
  });
});
