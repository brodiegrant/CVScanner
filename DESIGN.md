# DESIGN

## OAuth flow
The project uses OAuth 2.0 Authorization Code against a local loopback callback (`http://127.0.0.1:<port>/oauth/callback`). This works for a local scheduled job because consent is performed once interactively and refresh tokens are then reused for unattended runs.

For a future multi-user web deployment, migrate to a web auth-code + PKCE model with server-side session binding and per-user token tenancy.

## Gmail scope
Current scope is least-privilege:
- `https://www.googleapis.com/auth/gmail.readonly`

This supports read/list/get and prevents mutation actions. If future workflows need relabel/delete, add broader scopes only for those features.

## Incremental algorithm
Strategy B implemented:
1. Load cursor `last_success_internalDate`.
2. Query Gmail with `q=after:<unix_seconds>` and selected label.
3. Fetch metadata and sort oldest-first by `internalDate`.
4. Skip message IDs already in a rolling dedupe set (14d default).
5. After successful message unit-of-work, mark message as processed and advance cursor conservatively to that message's date.

Edge cases covered: relabeling, clock drift, duplicate returns across runs.

## Body-to-LLM handoff
Email body is extracted from `text/plain`, with HTML stripped fallback, normalized, and truncated by config.
The normalized body is carried in the internal payload field `screeningSourceText` for downstream LLM scoring.

Operational logs/metrics never include body text, raw MIME, or attachment bytes.

## Security notes
- Tokens encrypted at rest via AES-256-GCM.
- Encryption key from `.env` (`TOKEN_ENC_KEY`) must decode to 32 bytes.
- Fresh random IV generated per encryption.
- Structured logging applies redaction helpers and avoids sensitive fields.
- Metrics/reporting are non-sensitive and aggregate-focused.
