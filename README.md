# CVScanner Intake Infrastructure

Gmail OAuth + ingestion layer for CV intake.

## Features
- One-time OAuth consent using localhost callback.
- Encrypted token storage in SQLite (AES-256-GCM).
- Incremental/idempotent ingest using timestamp watermark + message-id dedupe window.
- Label-based Gmail read (`Process` by default).
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
- optional `GMAIL_LABEL=Process`

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

## Scheduling (cron every 5 min)
```cron
*/5 * * * * cd /path/to/CVScanner && /usr/bin/npm run ingest -- --account=you@example.com >> ./data/ingest.log 2>&1
```

## Notes
- Intake does not mutate Gmail state (no move/delete/label changes).
- Intake stops on fatal error and does not advance cursor past failed work.
- Logs and metrics intentionally exclude email bodies and attachment contents.
