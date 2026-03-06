import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';

const REQUIRED_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  TOKEN_ENC_KEY: 'enc-key'
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
  });

  it('throws on invalid boolean values', () => {
    withEnv({ METRICS_ENABLED: 'maybe' });

    expect(() => loadConfig()).toThrow(/Expected a boolean value/);
  });
});
