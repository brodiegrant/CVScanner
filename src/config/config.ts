import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { ZodError, z } from 'zod';

dotenv.config();

const envBoolean = (defaultValue: boolean) =>
  z.union([z.boolean(), z.string()])
    .transform((value, ctx) => {
      if (typeof value === 'boolean') return value;

      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes'].includes(normalized)) return true;
      if (['false', '0', 'no'].includes(normalized)) return false;

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Expected a boolean value (true/false/1/0/yes/no)'
      });
      return z.NEVER;
    })
    .default(defaultValue);

const nonEmptyString = (name: string) =>
  z.string().trim().min(1, `${name} is required`);

const absoluteUrl = (name: string) =>
  z
    .string()
    .trim()
    .url(`${name} must be a valid absolute URL`);

const schema = z.object({
  GOOGLE_OAUTH_CLIENT_ID: nonEmptyString('GOOGLE_OAUTH_CLIENT_ID'),
  GOOGLE_OAUTH_CLIENT_SECRET: nonEmptyString('GOOGLE_OAUTH_CLIENT_SECRET'),
  GOOGLE_OAUTH_REDIRECT_HOST: z.string().default('127.0.0.1'),
  GOOGLE_OAUTH_REDIRECT_PORT: z.coerce.number().int().positive().default(53682),
  TOKEN_ENC_KEY: nonEmptyString('TOKEN_ENC_KEY'),
  SQLITE_PATH: z.string().default('./data/cvscanner.db'),
  METRICS_JSONL_PATH: z.string().default('./data/metrics.jsonl'),
  GMAIL_LABEL: z.string().default('Process'),
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  ATTACHMENT_ALLOWED_MIME_TYPES: z.string().default('application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  ATTACHMENT_ALLOWED_EXTENSIONS: z.string().default('pdf,doc,docx'),
  ATTACHMENT_ALLOW_ARCHIVES: envBoolean(false),
  ATTACHMENT_MAX_ARCHIVE_EXPANSION_RATIO: z.coerce.number().positive().default(30),
  DEDUPE_LOOKBACK_DAYS: z.coerce.number().int().positive().default(14),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  METRICS_ENABLED: envBoolean(true),
  INGEST_BODY_MAX_CHARS: z.coerce.number().int().positive().default(12000),
  INGEST_INCLUDE_BODY: envBoolean(true),
  INTERNAL_REVIEW_API_ENABLED: envBoolean(false),
  INTERNAL_REVIEW_API_HOST: z.string().default('127.0.0.1'),
  INTERNAL_REVIEW_API_PORT: z.coerce.number().int().positive().default(53901),
  OPENAI_API_KEY: nonEmptyString('OPENAI_API_KEY'),
  LLM_MODEL: nonEmptyString('LLM_MODEL').default('gpt-4o-mini'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(2),
  VINCERE_API_BASE_URL: absoluteUrl('VINCERE_API_BASE_URL').default('https://api.vincere.io'),
  VINCERE_API_KEY: nonEmptyString('VINCERE_API_KEY'),
  VINCERE_TOKEN_STRATEGY: z.enum(['static_id_token', 'oauth_refresh_token']).default('static_id_token'),
  VINCERE_ID_TOKEN: z.string().trim().optional(),
  VINCERE_OAUTH_CLIENT_ID: z.string().trim().optional(),
  VINCERE_OAUTH_CLIENT_SECRET: z.string().trim().optional(),
  VINCERE_OAUTH_REDIRECT_URI: z.string().trim().optional(),
  VINCERE_OAUTH_SCOPE: z.string().trim().default('openid profile offline_access'),
  VINCERE_OAUTH_AUDIENCE: z.string().trim().optional(),
  VINCERE_OAUTH_REFRESH_TOKEN: z.string().trim().optional()
}).superRefine((value, ctx) => {
  if (value.VINCERE_TOKEN_STRATEGY === 'static_id_token') {
    if (!value.VINCERE_ID_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['VINCERE_ID_TOKEN'],
        message: 'VINCERE_ID_TOKEN is required when VINCERE_TOKEN_STRATEGY=static_id_token'
      });
    }
    return;
  }

  const requiredOauthFields = [
    'VINCERE_OAUTH_CLIENT_ID',
    'VINCERE_OAUTH_CLIENT_SECRET',
    'VINCERE_OAUTH_REDIRECT_URI',
    'VINCERE_OAUTH_REFRESH_TOKEN'
  ] as const;

  for (const field of requiredOauthFields) {
    if (!value[field]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is required when VINCERE_TOKEN_STRATEGY=oauth_refresh_token`
      });
    }
  }
});

type ParsedConfig = z.infer<typeof schema>;

export type AppConfig = {
  oauth: { clientId: string; clientSecret: string; redirectHost: string; redirectPort: number };
  tokenEncKey: string;
  sqlitePath: string;
  metricsJsonlPath: string;
  defaultLabel: string;
  maxAttachmentBytes: number;
  allowedAttachmentMimeTypes: string[];
  allowedAttachmentExtensions: string[];
  allowAttachmentArchives: boolean;
  maxArchiveExpansionRatio: number;
  dedupeLookbackDays: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  metricsEnabled: boolean;
  ingestBodyMaxChars: number;
  ingestIncludeBody: boolean;
  reviewApi: {
    enabled: boolean;
    host: string;
    port: number;
  };
  llm: {
    apiKey: string;
    model: string;
    timeoutMs: number;
    maxRetries: number;
  };
  vincere: {
    apiBaseUrl: string;
    apiKey: string;
    tokenStrategy: 'static_id_token' | 'oauth_refresh_token';
    idToken?: string;
    oauth: {
      clientId?: string;
      clientSecret?: string;
      redirectUri?: string;
      scope: string;
      audience?: string;
      refreshToken?: string;
    };
  };
};

function parseEnvironment(input: Record<string, unknown>): ParsedConfig {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;

  throw new Error(formatConfigError(parsed.error));
}

function formatConfigError(error: ZodError): string {
  const lines = error.issues.map((issue) => {
    const field = issue.path[0] ?? 'UNKNOWN_ENV';
    return `- ${String(field)}: ${issue.message}`;
  });

  return `Invalid environment configuration:\n${lines.join('\n')}`;
}

export function loadConfig(): AppConfig {
  const jsonPath = process.env.CONFIG_JSON_PATH;
  const fromJson = jsonPath && fs.existsSync(jsonPath)
    ? JSON.parse(fs.readFileSync(path.resolve(jsonPath), 'utf8'))
    : {};

  const parsed = parseEnvironment({ ...fromJson, ...process.env });
  return {
    oauth: {
      clientId: parsed.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: parsed.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectHost: parsed.GOOGLE_OAUTH_REDIRECT_HOST,
      redirectPort: parsed.GOOGLE_OAUTH_REDIRECT_PORT
    },
    tokenEncKey: parsed.TOKEN_ENC_KEY,
    sqlitePath: parsed.SQLITE_PATH,
    metricsJsonlPath: parsed.METRICS_JSONL_PATH,
    defaultLabel: parsed.GMAIL_LABEL,
    maxAttachmentBytes: parsed.ATTACHMENT_MAX_BYTES,
    allowedAttachmentMimeTypes: parsed.ATTACHMENT_ALLOWED_MIME_TYPES.split(',').map((v) => v.trim().toLowerCase()),
    allowedAttachmentExtensions: parsed.ATTACHMENT_ALLOWED_EXTENSIONS.split(',').map((v) => v.trim().toLowerCase()),
    allowAttachmentArchives: parsed.ATTACHMENT_ALLOW_ARCHIVES,
    maxArchiveExpansionRatio: parsed.ATTACHMENT_MAX_ARCHIVE_EXPANSION_RATIO,
    dedupeLookbackDays: parsed.DEDUPE_LOOKBACK_DAYS,
    logLevel: parsed.LOG_LEVEL,
    metricsEnabled: parsed.METRICS_ENABLED,
    ingestBodyMaxChars: parsed.INGEST_BODY_MAX_CHARS,
    ingestIncludeBody: parsed.INGEST_INCLUDE_BODY,
    reviewApi: {
      enabled: parsed.INTERNAL_REVIEW_API_ENABLED,
      host: parsed.INTERNAL_REVIEW_API_HOST,
      port: parsed.INTERNAL_REVIEW_API_PORT
    },
    llm: {
      apiKey: parsed.OPENAI_API_KEY,
      model: parsed.LLM_MODEL,
      timeoutMs: parsed.LLM_TIMEOUT_MS,
      maxRetries: parsed.LLM_MAX_RETRIES
    },
    vincere: {
      apiBaseUrl: parsed.VINCERE_API_BASE_URL,
      apiKey: parsed.VINCERE_API_KEY,
      tokenStrategy: parsed.VINCERE_TOKEN_STRATEGY,
      idToken: parsed.VINCERE_ID_TOKEN,
      oauth: {
        clientId: parsed.VINCERE_OAUTH_CLIENT_ID,
        clientSecret: parsed.VINCERE_OAUTH_CLIENT_SECRET,
        redirectUri: parsed.VINCERE_OAUTH_REDIRECT_URI,
        scope: parsed.VINCERE_OAUTH_SCOPE,
        audience: parsed.VINCERE_OAUTH_AUDIENCE,
        refreshToken: parsed.VINCERE_OAUTH_REFRESH_TOKEN
      }
    }
  };
}
