import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';

const REQUIRED_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  TOKEN_ENC_KEY: 'enc-key',
  OPENAI_API_KEY: 'openai-key',
  VINCERE_API_KEY: 'vincere-key',
  VINCERE_ID_TOKEN: 'vincere-id-token'
};

function withEnv(overrides: Record<string, string | undefined>) {
  Object.assign(process.env, REQUIRED_ENV, overrides);
}

describe('environment boolean parsing', () => {
  it('parses "true" to true', () => {
    withEnv({ METRICS_ENABLED: 'true', INGEST_INCLUDE_BODY: 'true' });

    const config = loadConfig();

    expect(config.metricsEnabled).toBe(true);
    expect(config.ingestIncludeBody).toBe(true);
    expect(config.maxAttachmentBytes).toBe(10 * 1024 * 1024);
    expect(config.allowedAttachmentMimeTypes).toContain('application/pdf');
    expect(config.allowAttachmentArchives).toBe(false);
    expect(config.maxArchiveExpansionRatio).toBe(30);
    expect(config.reviewApi.enabled).toBe(false);
    expect(config.reviewApi.host).toBe('127.0.0.1');
    expect(config.reviewApi.port).toBe(53901);
  });

  it('parses "false" to false', () => {
    withEnv({ METRICS_ENABLED: 'false', INGEST_INCLUDE_BODY: 'false' });

    const config = loadConfig();

    expect(config.metricsEnabled).toBe(false);
    expect(config.ingestIncludeBody).toBe(false);
  });

  it('uses defaults when values are missing', () => {
    withEnv({ METRICS_ENABLED: undefined, INGEST_INCLUDE_BODY: undefined });
    delete process.env.METRICS_ENABLED;
    delete process.env.INGEST_INCLUDE_BODY;

    const config = loadConfig();

    expect(config.metricsEnabled).toBe(true);
    expect(config.ingestIncludeBody).toBe(true);
    expect(config.maxAttachmentBytes).toBe(10 * 1024 * 1024);
    expect(config.allowedAttachmentMimeTypes).toContain('application/pdf');
    expect(config.allowAttachmentArchives).toBe(false);
    expect(config.maxArchiveExpansionRatio).toBe(30);
  });

  it('throws on invalid boolean values', () => {
    withEnv({ METRICS_ENABLED: 'maybe' });

    expect(() => loadConfig()).toThrow(/Expected a boolean value/);
  });

  it('throws clear strategy-specific errors for oauth refresh token strategy', () => {
    withEnv({
      METRICS_ENABLED: 'true',
      VINCERE_TOKEN_STRATEGY: 'oauth_refresh_token',
      VINCERE_ID_TOKEN: undefined,
      VINCERE_OAUTH_CLIENT_ID: undefined,
      VINCERE_OAUTH_CLIENT_SECRET: undefined,
      VINCERE_OAUTH_REDIRECT_URI: undefined,
      VINCERE_OAUTH_REFRESH_TOKEN: undefined
    });
    delete process.env.VINCERE_ID_TOKEN;
    delete process.env.VINCERE_OAUTH_CLIENT_ID;
    delete process.env.VINCERE_OAUTH_CLIENT_SECRET;
    delete process.env.VINCERE_OAUTH_REDIRECT_URI;
    delete process.env.VINCERE_OAUTH_REFRESH_TOKEN;

    expect(() => loadConfig()).toThrow(/VINCERE_OAUTH_CLIENT_ID is required when VINCERE_TOKEN_STRATEGY=oauth_refresh_token/);
  });
});
