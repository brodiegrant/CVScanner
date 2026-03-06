import express from 'express';
import { Server } from 'node:http';

export function waitForOAuthCode(host: string, port: number, timeoutMs = 180000): Promise<string> {
  return new Promise((resolve, reject) => {
    const app = express();
    let server: Server;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
    };

    const settleResolve = (code: string) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(code);
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
      const code = req.query.code;
      if (typeof code !== 'string') {
        res.status(400).send('Missing code');
        return;
      }
      res.send('Authorization successful. You can close this tab.');
      server.close();
      settleResolve(code);
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
