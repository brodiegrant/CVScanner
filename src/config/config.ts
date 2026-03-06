import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envBoolean = (defaultValue: boolean) =>
  z.union([
    z.boolean(),
    z
      .string()
      .trim()
      .toLowerCase()
      .refine((value) => ['true', 'false', '1', '0', 'yes', 'no'].includes(value), {
        message: 'Expected a boolean value (true/false/1/0/yes/no)'
      })
      .transform((value) => ['true', '1', 'yes'].includes(value))
  ]).default(defaultValue);

const schema = z.object({
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  GOOGLE_OAUTH_REDIRECT_HOST: z.string().default('127.0.0.1'),
  GOOGLE_OAUTH_REDIRECT_PORT: z.coerce.number().int().positive().default(53682),
  TOKEN_ENC_KEY: z.string().min(1),
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
  INGEST_INCLUDE_BODY: envBoolean(true)
});

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
};

export function loadConfig(): AppConfig {
  const jsonPath = process.env.CONFIG_JSON_PATH;
  const fromJson = jsonPath && fs.existsSync(jsonPath)
    ? JSON.parse(fs.readFileSync(path.resolve(jsonPath), 'utf8'))
    : {};

  const parsed = schema.parse({ ...fromJson, ...process.env });
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
    ingestIncludeBody: parsed.INGEST_INCLUDE_BODY
  };
}
