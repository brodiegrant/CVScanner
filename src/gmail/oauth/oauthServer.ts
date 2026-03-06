import express from 'express';
import { Server } from 'node:http';

export type OAuthCallbackPayload = {
  code: string;
  state?: string;
};

export function waitForOAuthCode(host: string, port: number, timeoutMs = 180000): Promise<OAuthCallbackPayload> {
  return new Promise((resolve, reject) => {
    const app = express();
    let server: Server;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
    };

    const settleResolve = (payload: OAuthCallbackPayload) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(payload);
    };

    const settleReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const timer = setTimeout(() => {
      server?.close();
      settleReject(new Error('OAuth callback timed out'));
    }, timeoutMs);

    app.get('/oauth/callback', (req, res) => {
      const error = req.query.error;
      if (typeof error === 'string') {
        const description = typeof req.query.error_description === 'string' ? ` (${req.query.error_description})` : '';
        res.status(400).send('Authorization failed. You can close this tab.');
        server.close();
        settleReject(new Error(`OAuth callback returned error: ${error}${description}`));
        return;
      }

      const code = req.query.code;
      if (typeof code !== 'string') {
        res.status(400).send('Missing code');
        server.close();
        settleReject(new Error('OAuth callback missing authorization code'));
        return;
      }

      const state = typeof req.query.state === 'string' ? req.query.state : undefined;
      res.send('Authorization successful. You can close this tab.');
      server.close();
      settleResolve({ code, state });
    });

    server = app.listen(port, host);
    server.on('error', (error) => {
      const serverError = error as NodeJS.ErrnoException;
      settleReject(
        new Error(
          `Failed to start OAuth callback server on ${host}:${port} (${serverError.code ?? 'UNKNOWN'}): ${serverError.message}`,
        ),
      );
    });
  });
}
