export const VINCERE_AUTHORIZE_URL = 'https://id.vincere.io/oauth2/authorize';
export const VINCERE_TOKEN_URL = 'https://id.vincere.io/oauth2/token';

export type VincereOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type VincereTokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
};

export type VincereTokenSet = {
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  tokenType: string;
  expiresIn: number;
  scope?: string;
  acquiredAt: number;
};

function toTokenSet(res: VincereTokenResponse): VincereTokenSet {
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    idToken: res.id_token,
    tokenType: res.token_type,
    expiresIn: res.expires_in,
    scope: res.scope,
    acquiredAt: Date.now()
  };
}

async function fetchToken(config: VincereOAuthConfig, body: URLSearchParams): Promise<VincereTokenSet> {
  const response = await fetch(VINCERE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Vincere token exchange failed (${response.status}): ${text}`);
  }

  const json = await response.json() as VincereTokenResponse;
  return toTokenSet(json);
}

export function buildVincereAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
  audience?: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    scope: opts.scope
  });

  if (opts.audience) params.set('audience', opts.audience);

  return `${VINCERE_AUTHORIZE_URL}?${params.toString()}`;
}

export async function acquireVincereToken(config: VincereOAuthConfig, code: string): Promise<VincereTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri
  });

  return fetchToken(config, body);
}

export async function refreshVincereToken(config: VincereOAuthConfig, refreshToken: string): Promise<VincereTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret
  });

  return fetchToken(config, body);
}

export function isTokenExpiringSoon(token: VincereTokenSet, withinSeconds = 60): boolean {
  const expiresAt = token.acquiredAt + (token.expiresIn * 1000);
  return (Date.now() + withinSeconds * 1000) >= expiresAt;
}
