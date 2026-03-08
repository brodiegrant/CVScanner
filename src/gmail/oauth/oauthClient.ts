import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { google } from 'googleapis';
import { AppConfig } from '../../config/config.js';
import { waitForOAuthCode } from './oauthServer.js';
import { TokenStore } from '../../storage/tokenStore.js';

const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function randomBase64Url(bytes: number) {
  return randomBytes(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function getOpenCommand(url: string) {
  if (process.platform === 'darwin') return { command: 'open', args: [url] };
  if (process.platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return { command: 'xdg-open', args: [url] };
}

export function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { command, args } = getOpenCommand(url);
    let settled = false;

    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore'
    });

    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve(true);
    });

    child.once('error', () => {
      if (settled) return;
      settled = true;
      resolve(false);
    });
  });
}

export async function connectAccount(
  config: AppConfig,
  tokenStore: TokenStore,
  openUrl: (url: string) => Promise<boolean> = openBrowser
): Promise<{ accountEmail: string }> {
  const redirectUri = `http://${config.oauth.redirectHost}:${config.oauth.redirectPort}/oauth/callback`;
  const oauth2Client = new google.auth.OAuth2(config.oauth.clientId, config.oauth.clientSecret, redirectUri);

  const state = randomBase64Url(24);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [GMAIL_READONLY_SCOPE],
    state
  });

  const openedBrowser = await openUrl(authUrl);
  if (!openedBrowser) {
    console.error(`Automatic browser launch failed. Authorization URL: ${authUrl}`);
  }
  console.info(`If your browser did not open, visit: ${authUrl}`);

  const callback = await waitForOAuthCode(config.oauth.redirectHost, config.oauth.redirectPort);
  if (!callback.state || callback.state !== state) {
    throw new Error('OAuth state mismatch. Please retry account connection.');
  }

  const { tokens } = await oauth2Client.getToken(callback.code);
  oauth2Client.setCredentials(tokens);

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const accountEmail = profile.data.emailAddress;
  if (!accountEmail || !tokens.refresh_token || !tokens.access_token || !tokens.expiry_date) {
    throw new Error('Failed to retrieve complete token/profile information from OAuth flow');
  }

  tokenStore.upsert({
    accountEmail,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date
  });

  return { accountEmail };
}

export function createAuthorizedClient(config: AppConfig, tokenStore: TokenStore, accountEmail: string) {
  const redirectUri = `http://${config.oauth.redirectHost}:${config.oauth.redirectPort}/oauth/callback`;
  const oauth2Client = new google.auth.OAuth2(config.oauth.clientId, config.oauth.clientSecret, redirectUri);
  const stored = tokenStore.get(accountEmail);
  if (!stored) throw new Error(`No stored token for account ${accountEmail}`);

  oauth2Client.setCredentials({
    access_token: stored.accessToken,
    refresh_token: stored.refreshToken,
    expiry_date: stored.expiryDate
  });

  oauth2Client.on('tokens', (tokens) => {
    const accessToken = tokens.access_token ?? undefined;
    const refreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token.trim().length > 0
      ? tokens.refresh_token
      : undefined;
    const expiryDate = tokens.expiry_date ?? undefined;

    tokenStore.merge(accountEmail, { accessToken, refreshToken, expiryDate });
  });

  return oauth2Client;
}
