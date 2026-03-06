import { describe, expect, it } from 'vitest';
import { waitForOAuthCode } from '../src/gmail/oauth/oauthServer.js';

async function getFreePort() {
  const { createServer } = await import('node:net');
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to read ephemeral port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

describe('waitForOAuthCode', () => {
  it('resolves with code and state when callback includes both', async () => {
    const port = await getFreePort();
    const promise = waitForOAuthCode('127.0.0.1', port, 2000);

    const response = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=abc123&state=state-1`);
    expect(response.status).toBe(200);

    const payload = await promise;
    expect(payload).toEqual({ code: 'abc123', state: 'state-1' });
  });

  it('rejects when callback has no code', async () => {
    const port = await getFreePort();
    const promise = waitForOAuthCode('127.0.0.1', port, 2000);
    const settledError = promise.catch((error) => error as Error);

    const response = await fetch(`http://127.0.0.1:${port}/oauth/callback`);
    expect(response.status).toBe(400);

    const error = await settledError;
    expect(error.message).toContain('missing authorization code');
  });
});
