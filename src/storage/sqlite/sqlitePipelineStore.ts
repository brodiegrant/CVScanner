import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type CandidateExtractionRow = {
  accountEmail: string;
  messageId: string;
  contentHash: string | null;
  status: 'pending' | 'parsed' | 'rejected' | 'error';
  rawModelOutput: string;
  parsedJson: string | null;
  rejectionReason: string | null;
  modelName: string;
  promptVersion: string;
};

export type VincereSyncAttemptRow = {
  messageId: string;
  candidateIdentifier: string;
  matchOutcome: 'matched' | 'no_match' | 'ambiguous';
  matchedCandidateId: string | null;
  tagsProposed: string;
  tagsApplied: string;
  resultStatus: 'success' | 'error' | 'skipped';
  errorText: string | null;
  candidateLookupOutcome?: string | null;
  candidateUpsertOutcome?: string | null;
  expertiseLinkPayload?: string | null;
  expertiseLinkResult?: string | null;
  documentUploadAttempted?: boolean;
  documentUploadResult?: string | null;
  documentUploadErrorText?: string | null;
  resolvedUploadCandidateId?: string | null;
};

export type ManualReviewQueueRow = {
  reason: 'low_tag_count' | 'ambiguous_match' | 'sync_error' | 'extraction_error';
  messageId: string;
  candidateHints: string;
  payloadSnapshot: string;
};

export type ManualReviewQueueEntry = ManualReviewQueueRow & {
  createdAt: string;
  updatedAt: string;
};

export type CandidateExtractionSnapshot = {
  status: CandidateExtractionRow['status'];
  parsedJson: string | null;
  rawModelOutput: string;
};

export class SqlitePipelineStore {
  private readonly db: any;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candidate_extractions (
        account_email TEXT NOT NULL,
        message_id TEXT NOT NULL,
        content_hash TEXT,
        status TEXT NOT NULL,
        raw_model_output TEXT NOT NULL,
        parsed_json TEXT,
        rejection_reason TEXT,
        model_name TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_email, message_id)
      );

      CREATE TABLE IF NOT EXISTS vincere_sync_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        candidate_identifier TEXT NOT NULL,
        match_outcome TEXT NOT NULL,
        matched_candidate_id TEXT,
        tags_proposed TEXT NOT NULL,
        tags_applied TEXT NOT NULL,
        result_status TEXT NOT NULL,
        error_text TEXT,
        candidate_lookup_outcome TEXT,
        candidate_upsert_outcome TEXT,
        expertise_link_payload TEXT,
        expertise_link_result TEXT,
        document_upload_attempted INTEGER NOT NULL DEFAULT 0,
        document_upload_result TEXT,
        document_upload_error_text TEXT,
        resolved_upload_candidate_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vincere_sync_message_id ON vincere_sync_attempts(message_id);

      CREATE TABLE IF NOT EXISTS manual_review_queue (
        reason TEXT NOT NULL,
        message_id TEXT NOT NULL,
        candidate_hints TEXT NOT NULL,
        payload_snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (reason, message_id)
      );
    `);
    this.ensureVincereSyncAttemptColumns();
  }

  upsertCandidateExtraction(row: CandidateExtractionRow): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO candidate_extractions(
        account_email,
        message_id,
        content_hash,
        status,
        raw_model_output,
        parsed_json,
        rejection_reason,
        model_name,
        prompt_version,
        created_at,
        updated_at
      )
      VALUES(
        @accountEmail,
        @messageId,
        @contentHash,
        @status,
        @rawModelOutput,
        @parsedJson,
        @rejectionReason,
        @modelName,
        @promptVersion,
        @now,
        @now
      )
      ON CONFLICT(account_email, message_id) DO UPDATE SET
        content_hash=excluded.content_hash,
        status=excluded.status,
        raw_model_output=excluded.raw_model_output,
        parsed_json=excluded.parsed_json,
        rejection_reason=excluded.rejection_reason,
        model_name=excluded.model_name,
        prompt_version=excluded.prompt_version,
        updated_at=excluded.updated_at
    `).run({ ...row, now });
  }

  insertVincereSyncAttempt(row: VincereSyncAttemptRow): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO vincere_sync_attempts(
        message_id,
        candidate_identifier,
        match_outcome,
        matched_candidate_id,
        tags_proposed,
        tags_applied,
        result_status,
        error_text,
        candidate_lookup_outcome,
        candidate_upsert_outcome,
        expertise_link_payload,
        expertise_link_result,
        document_upload_attempted,
        document_upload_result,
        document_upload_error_text,
        resolved_upload_candidate_id,
        created_at,
        updated_at
      )
      VALUES(
        @messageId,
        @candidateIdentifier,
        @matchOutcome,
        @matchedCandidateId,
        @tagsProposed,
        @tagsApplied,
        @resultStatus,
        @errorText,
        @candidateLookupOutcome,
        @candidateUpsertOutcome,
        @expertiseLinkPayload,
        @expertiseLinkResult,
        @documentUploadAttempted,
        @documentUploadResult,
        @documentUploadErrorText,
        @resolvedUploadCandidateId,
        @now,
        @now
      )
    `).run({
      ...row,
      candidateLookupOutcome: row.candidateLookupOutcome ?? null,
      candidateUpsertOutcome: row.candidateUpsertOutcome ?? null,
      expertiseLinkPayload: row.expertiseLinkPayload ?? null,
      expertiseLinkResult: row.expertiseLinkResult ?? null,
      documentUploadAttempted: row.documentUploadAttempted ? 1 : 0,
      documentUploadResult: row.documentUploadResult ?? null,
      documentUploadErrorText: row.documentUploadErrorText ?? null,
      resolvedUploadCandidateId: row.resolvedUploadCandidateId ?? null,
      now
    });
  }

  private ensureVincereSyncAttemptColumns(): void {
    const existingColumns = new Set(
      (this.db.prepare(`PRAGMA table_info(vincere_sync_attempts)`).all() as Array<{ name: string }>)
        .map((column) => column.name)
    );

    const missingColumns = [
      {
        name: 'candidate_lookup_outcome',
        definition: 'TEXT'
      },
      {
        name: 'candidate_upsert_outcome',
        definition: 'TEXT'
      },
      {
        name: 'expertise_link_payload',
        definition: 'TEXT'
      },
      {
        name: 'expertise_link_result',
        definition: 'TEXT'
      },
      {
        name: 'document_upload_attempted',
        definition: 'INTEGER NOT NULL DEFAULT 0'
      },
      {
        name: 'document_upload_result',
        definition: 'TEXT'
      },
      {
        name: 'document_upload_error_text',
        definition: 'TEXT'
      },
      {
        name: 'resolved_upload_candidate_id',
        definition: 'TEXT'
      }
    ].filter((column) => !existingColumns.has(column.name));

    if (missingColumns.length === 0) {
      return;
    }

    const alterTable = this.db.transaction((columns: Array<{ name: string; definition: string }>) => {
      for (const column of columns) {
        this.db.exec(`
          ALTER TABLE vincere_sync_attempts
          ADD COLUMN ${column.name} ${column.definition}
        `);
      }
    });

    alterTable(missingColumns);
  }

  upsertManualReviewQueue(row: ManualReviewQueueRow): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO manual_review_queue(
        reason,
        message_id,
        candidate_hints,
        payload_snapshot,
        created_at,
        updated_at
      ) VALUES(
        @reason,
        @messageId,
        @candidateHints,
        @payloadSnapshot,
        @now,
        @now
      )
      ON CONFLICT(reason, message_id) DO UPDATE SET
        candidate_hints=excluded.candidate_hints,
        payload_snapshot=excluded.payload_snapshot,
        updated_at=excluded.updated_at
    `).run({ ...row, now });
  }

  listManualReviewQueue(): ManualReviewQueueEntry[] {
    return this.db.prepare(`
      SELECT
        reason AS reason,
        message_id AS messageId,
        candidate_hints AS candidateHints,
        payload_snapshot AS payloadSnapshot,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM manual_review_queue
      ORDER BY updated_at DESC
    `).all() as ManualReviewQueueEntry[];
  }

  getManualReviewByMessageId(messageId: string): ManualReviewQueueEntry[] {
    return this.db.prepare(`
      SELECT
        reason AS reason,
        message_id AS messageId,
        candidate_hints AS candidateHints,
        payload_snapshot AS payloadSnapshot,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM manual_review_queue
      WHERE message_id = ?
      ORDER BY updated_at DESC
    `).all(messageId) as ManualReviewQueueEntry[];
  }

  getLatestExtractionByMessageId(messageId: string): CandidateExtractionSnapshot | null {
    return this.db.prepare(`
      SELECT
        status AS status,
        parsed_json AS parsedJson,
        raw_model_output AS rawModelOutput
      FROM candidate_extractions
      WHERE message_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(messageId) as CandidateExtractionSnapshot | undefined ?? null;
  }

  resolveManualReviewByMessageId(
    messageId: string,
    resolution: { decision: 'approved' | 'updated'; notes?: string; updatedPayload?: Record<string, unknown> | null }
  ): number {
    const rows = this.db.prepare(`
      SELECT
        reason AS reason,
        message_id AS messageId,
        candidate_hints AS candidateHints,
        payload_snapshot AS payloadSnapshot
      FROM manual_review_queue
      WHERE message_id = ?
    `).all(messageId) as ManualReviewQueueRow[];

    if (rows.length === 0) {
      return 0;
    }

    const now = new Date().toISOString();
    const updateStmt = this.db.prepare(`
      UPDATE manual_review_queue
      SET payload_snapshot = @payloadSnapshot, updated_at = @now
      WHERE reason = @reason AND message_id = @messageId
    `);

    let updatedRows = 0;
    for (const row of rows) {
      const snapshot = parseJsonObject(row.payloadSnapshot);
      const nextSnapshot = {
        ...snapshot,
        resolution: {
          decision: resolution.decision,
          notes: resolution.notes ?? null,
          updatedPayload: resolution.updatedPayload ?? null,
          resolvedAt: now
        }
      };
      const result = updateStmt.run({
        reason: row.reason,
        messageId: row.messageId,
        payloadSnapshot: JSON.stringify(nextSnapshot),
        now
      });
      updatedRows += Number(result.changes ?? 0);
    }

    return updatedRows;
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }

  return { rawSnapshot: value };
}
