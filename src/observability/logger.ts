export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEYS = new Set(['accessToken', 'refreshToken', 'token', 'body', 'raw', 'attachmentBytes', 'mime']);

export function redact<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : redact(v);
  }
  return out as T;
}

export function createLogger(minLevel: LogLevel) {
  const should = (lvl: LogLevel) => rank[lvl] >= rank[minLevel];
  return {
    log(level: LogLevel, message: string, fields: Record<string, unknown> = {}) {
      if (!should(level)) return;
      process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, message, ...redact(fields) })}\n`);
    },
    debug(message: string, fields?: Record<string, unknown>) { this.log('debug', message, fields); },
    info(message: string, fields?: Record<string, unknown>) { this.log('info', message, fields); },
    warn(message: string, fields?: Record<string, unknown>) { this.log('warn', message, fields); },
    error(message: string, fields?: Record<string, unknown>) { this.log('error', message, fields); }
  };
}
