import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type ExtractionAttemptStatus = 'pending' | 'parsed' | 'rejected' | 'error';

export type ExtractionAttemptRow = {
  extractionKey: string;
  status: ExtractionAttemptStatus;
  rawModelOutput: string;
  parsedTagExplanationJson: string | null;
  rejectionReason: string | null;
  modelName: string;
  promptVersion: string;
  errorDetails: string | null;
};

export type ExtractionAttemptSnapshot = ExtractionAttemptRow & {
  createdAt: string;
  updatedAt: string;
};

export class SqliteExtractionStore {
  private readonly db: any;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extractions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        extraction_key TEXT NOT NULL,
        status TEXT NOT NULL,
        raw_model_output TEXT NOT NULL,
        parsed_tag_explanations_json TEXT,
        rejection_reason TEXT,
        model_name TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        error_details TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_extractions_key ON extractions(extraction_key);
      CREATE INDEX IF NOT EXISTS idx_extractions_key_updated_at ON extractions(extraction_key, updated_at DESC);
    `);
  }

  insertExtractionAttempt(row: ExtractionAttemptRow): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO extractions(
        extraction_key,
        status,
        raw_model_output,
        parsed_tag_explanations_json,
        rejection_reason,
        model_name,
        prompt_version,
        error_details,
        created_at,
        updated_at
      )
      VALUES(
        @extractionKey,
        @status,
        @rawModelOutput,
        @parsedTagExplanationJson,
        @rejectionReason,
        @modelName,
        @promptVersion,
        @errorDetails,
        @now,
        @now
      )
    `).run({ ...row, now });
  }

  getLatestByExtractionKey(extractionKey: string): ExtractionAttemptSnapshot | null {
    return this.db.prepare(`
      SELECT
        extraction_key AS extractionKey,
        status AS status,
        raw_model_output AS rawModelOutput,
        parsed_tag_explanations_json AS parsedTagExplanationJson,
        rejection_reason AS rejectionReason,
        model_name AS modelName,
        prompt_version AS promptVersion,
        error_details AS errorDetails,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM extractions
      WHERE extraction_key = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(extractionKey) as ExtractionAttemptSnapshot | undefined ?? null;
  }
}
