import express from 'express';
import { Server } from 'node:http';

export function waitForOAuthCode(host: string, port: number, timeoutMs = 180000): Promise<string> {
  return new Promise((resolve, reject) => {
    const app = express();
    let server: Server;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      if (server?.listening) {
        server.close();
      }
    };

    const settleSuccess = (code: string) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(code);
    };

    const settleError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const timer = setTimeout(() => {
      settleError(new Error(`OAuth callback timed out while listening on ${host}:${port}`));
    }, timeoutMs);

    app.on('error', (error) => {
      settleError(new Error(`OAuth server runtime error on ${host}:${port}: ${String(error)}`));
    });

    app.get('/oauth/callback', (req, res) => {
      const code = req.query.code;
      if (typeof code !== 'string') {
        res.status(400).send('Missing code');
        return;
      }
      res.send('Authorization successful. You can close this tab.');
      settleSuccess(code);
    });

    server = app.listen(port, host);
    server.on('error', (error) => {
      settleError(new Error(`Failed to start OAuth server on ${host}:${port}: ${error.message}`));
    });
  });
}
