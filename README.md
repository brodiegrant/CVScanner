# CVScanner Intake Infrastructure

Gmail OAuth + ingestion layer for CV intake.

## Features
- One-time OAuth consent using localhost callback.
- Encrypted token storage in SQLite (AES-256-GCM).
- Incremental/idempotent ingest using timestamp watermark + message-id dedupe window.
- Label-based Gmail read (`Process` by default), accepting either label name or Gmail label ID.
- Attachment filtering (default `pdf,doc,docx`).
- Body-to-LLM handoff (`screeningSourceText`) with log redaction safeguards.
- JSON structured logs + JSONL metrics sink.

## Google Cloud setup
1. Enable Gmail API in Google Cloud Console.
2. Configure OAuth consent screen (External/Internal as needed).
3. Create OAuth client (Desktop or Web with loopback redirect).
4. Add redirect URI: `http://127.0.0.1:<PORT>/oauth/callback`.
5. Add Gmail test user if consent mode requires it.

## Local setup
```bash
npm install
cp .env.example .env
```

Generate encryption key (32 bytes base64):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Set `.env` values:
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_HOST=127.0.0.1`
- `GOOGLE_OAUTH_REDIRECT_PORT=53682`
- `TOKEN_ENC_KEY=<base64_32_byte_key>`
- `SQLITE_PATH=./data/cvscanner.db`
- `METRICS_JSONL_PATH=./data/metrics.jsonl`
- `OPENAI_API_KEY=<openai_api_key>`
- `LLM_MODEL=gpt-4o-mini` (or another supported model)
- `VINCERE_API_BASE_URL=https://api.vincere.io`
- `VINCERE_API_KEY=<vincere_api_key>`
- optional `GMAIL_LABEL=Process` (label name or ID; names are resolved to IDs at runtime)

### Vincere authentication strategy
Set `VINCERE_TOKEN_STRATEGY` to one of:

1. `static_id_token` (default): provide a pre-issued `VINCERE_ID_TOKEN`.
2. `oauth_refresh_token`: provide OAuth client credentials + refresh token and let the app refresh tokens.

Required variables by strategy:

- `static_id_token`
  - `VINCERE_ID_TOKEN`
- `oauth_refresh_token`
  - `VINCERE_OAUTH_CLIENT_ID`
  - `VINCERE_OAUTH_CLIENT_SECRET`
  - `VINCERE_OAUTH_REDIRECT_URI`
  - `VINCERE_OAUTH_REFRESH_TOKEN`
  - optional `VINCERE_OAUTH_SCOPE` (defaults to `openid profile offline_access`)
  - optional `VINCERE_OAUTH_AUDIENCE`

At startup, configuration is validated and the app exits with explicit errors if required env vars are missing/invalid.

## Environment examples
### Local development example (`.env`)
```dotenv
GOOGLE_OAUTH_CLIENT_ID=local-google-client-id
GOOGLE_OAUTH_CLIENT_SECRET=local-google-secret
GOOGLE_OAUTH_REDIRECT_HOST=127.0.0.1
GOOGLE_OAUTH_REDIRECT_PORT=53682
TOKEN_ENC_KEY=REPLACE_WITH_BASE64_32_BYTE_KEY
SQLITE_PATH=./data/cvscanner.db
METRICS_JSONL_PATH=./data/metrics.jsonl
GMAIL_LABEL=Process
OPENAI_API_KEY=sk-local
LLM_MODEL=gpt-4o-mini
LLM_TIMEOUT_MS=30000
LLM_MAX_RETRIES=2
VINCERE_API_BASE_URL=https://api.vincere.io
VINCERE_API_KEY=local-vincere-api-key
VINCERE_TOKEN_STRATEGY=static_id_token
VINCERE_ID_TOKEN=local-vincere-id-token
```

### Shared dev/staging example (OAuth refresh strategy)
```dotenv
GOOGLE_OAUTH_CLIENT_ID=dev-google-client-id
GOOGLE_OAUTH_CLIENT_SECRET=dev-google-secret
GOOGLE_OAUTH_REDIRECT_HOST=127.0.0.1
GOOGLE_OAUTH_REDIRECT_PORT=53682
TOKEN_ENC_KEY=REPLACE_WITH_BASE64_32_BYTE_KEY
OPENAI_API_KEY=sk-dev
LLM_MODEL=gpt-4o-mini
VINCERE_API_BASE_URL=https://api.vincere.io
VINCERE_API_KEY=dev-vincere-api-key
VINCERE_TOKEN_STRATEGY=oauth_refresh_token
VINCERE_OAUTH_CLIENT_ID=dev-vincere-client-id
VINCERE_OAUTH_CLIENT_SECRET=dev-vincere-client-secret
VINCERE_OAUTH_REDIRECT_URI=https://dev.example.com/oauth/vincere/callback
VINCERE_OAUTH_SCOPE=openid profile offline_access
VINCERE_OAUTH_REFRESH_TOKEN=dev-refresh-token
```

### Production example (shell env / secret manager mapping)
```bash
export GOOGLE_OAUTH_CLIENT_ID=prod-google-client-id
export GOOGLE_OAUTH_CLIENT_SECRET=prod-google-secret
export TOKEN_ENC_KEY=REPLACE_WITH_BASE64_32_BYTE_KEY
export OPENAI_API_KEY=sk-prod
export LLM_MODEL=gpt-4o-mini
export VINCERE_API_BASE_URL=https://api.vincere.io
export VINCERE_API_KEY=prod-vincere-api-key
export VINCERE_TOKEN_STRATEGY=oauth_refresh_token
export VINCERE_OAUTH_CLIENT_ID=prod-vincere-client-id
export VINCERE_OAUTH_CLIENT_SECRET=prod-vincere-client-secret
export VINCERE_OAUTH_REDIRECT_URI=https://cvscanner.example.com/oauth/vincere/callback
export VINCERE_OAUTH_REFRESH_TOKEN=prod-refresh-token
```

## Commands
Connect account (one-time consent):
```bash
npm run connect
```

Run ingestion:
```bash
npm run ingest -- --account=<email> --label="Process"
```

Dry-run ingestion (metadata + body extraction, no attachment bytes download):
```bash
npm run ingest -- --account=<email> --label="Process" --dry-run
```

Run summary counters:
- `counts.attachments_found`: number of attachment files matching allowed extensions discovered during ingest.
- `counts.attachments_downloaded`: total attachment bytes downloaded (0 in `--dry-run`).

Run internal review API (disabled by default):
```bash
npm run review-api
```

Build and tests:
```bash
npm run build
npm test
```


## Gmail label configuration
- `--label` and `GMAIL_LABEL` accept either a Gmail label name (for example `Process`) or a Gmail label ID (for example `Label_123456789`).
- During ingestion, the client resolves names to canonical Gmail label IDs via the Labels API and then uses those IDs for message listing.
- Existing configurations that already pass a label name continue to work; no migration is required.

## Scheduling (cron every 5 min)
```cron
*/5 * * * * cd /path/to/CVScanner && /usr/bin/npm run ingest -- --account=you@example.com >> ./data/ingest.log 2>&1
```

## Notes
- Intake does not mutate Gmail state (no move/delete/label changes).
- Intake stops on fatal error and does not advance cursor past failed work.
- Logs and metrics intentionally exclude email bodies and attachment contents.
- Internal review API is enabled only when `INTERNAL_REVIEW_API_ENABLED=true` and binds to `INTERNAL_REVIEW_API_HOST`/`INTERNAL_REVIEW_API_PORT` (default `127.0.0.1:53901`).
- Endpoints: `GET /review/queue`, `GET /review/item/:id`, `POST /review/item/:id/resolve`.
