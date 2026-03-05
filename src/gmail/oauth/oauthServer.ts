import express from 'express';
import { Server } from 'node:http';

export function waitForOAuthCode(host: string, port: number, timeoutMs = 180000): Promise<string> {
  return new Promise((resolve, reject) => {
    const app = express();
    let server: Server;
    const timer = setTimeout(() => {
      server?.close();
      reject(new Error('OAuth callback timed out'));
    }, timeoutMs);

    app.get('/oauth/callback', (req, res) => {
      const code = req.query.code;
      if (typeof code !== 'string') {
        res.status(400).send('Missing code');
        return;
      }
      clearTimeout(timer);
      res.send('Authorization successful. You can close this tab.');
      server.close();
      resolve(code);
    });

    server = app.listen(port, host);
  });
}
