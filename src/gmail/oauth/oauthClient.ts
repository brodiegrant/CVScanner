import { exec } from 'node:child_process';
import { google } from 'googleapis';
import { AppConfig } from '../../config/config.js';
import { waitForOAuthCode } from './oauthServer.js';
import { TokenStore } from '../../storage/tokenStore.js';

const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
}

export async function connectAccount(config: AppConfig, tokenStore: TokenStore): Promise<{ accountEmail: string }> {
  const redirectUri = `http://${config.oauth.redirectHost}:${config.oauth.redirectPort}/oauth/callback`;
  const oauth2Client = new google.auth.OAuth2(config.oauth.clientId, config.oauth.clientSecret, redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [GMAIL_READONLY_SCOPE]
  });

  openBrowser(authUrl);
  const code = await waitForOAuthCode(config.oauth.redirectHost, config.oauth.redirectPort);
  const { tokens } = await oauth2Client.getToken(code);
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
