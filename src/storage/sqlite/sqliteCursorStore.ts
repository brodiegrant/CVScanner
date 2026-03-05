import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Cursor, CursorStore } from '../cursorStore.js';

export class SqliteCursorStore implements CursorStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cursors (
        account_email TEXT NOT NULL,
        label TEXT NOT NULL,
        last_success_internal_date INTEGER NOT NULL,
        PRIMARY KEY (account_email, label)
      );
      CREATE TABLE IF NOT EXISTS processed_messages (
        account_email TEXT NOT NULL,
        label TEXT NOT NULL,
        message_id TEXT NOT NULL,
        internal_date INTEGER NOT NULL,
        processed_at INTEGER NOT NULL,
        PRIMARY KEY (account_email, label, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_processed_at ON processed_messages(processed_at);
    `);
  }

  getCursor(accountEmail: string, label: string): Cursor | null {
    const row = this.db.prepare('SELECT * FROM cursors WHERE account_email=? AND label=?').get(accountEmail, label) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { accountEmail, label, lastSuccessInternalDate: Number(row.last_success_internal_date) };
  }

  setCursor(accountEmail: string, label: string, lastSuccessInternalDate: number): void {
    this.db.prepare(`
      INSERT INTO cursors(account_email, label, last_success_internal_date)
      VALUES(?, ?, ?)
      ON CONFLICT(account_email, label) DO UPDATE SET last_success_internal_date=excluded.last_success_internal_date
    `).run(accountEmail, label, lastSuccessInternalDate);
  }

  isProcessed(accountEmail: string, label: string, messageId: string, lookbackDays: number): boolean {
    this.pruneProcessed(accountEmail, label, lookbackDays);
    const row = this.db.prepare('SELECT 1 FROM processed_messages WHERE account_email=? AND label=? AND message_id=?').get(accountEmail, label, messageId);
    return !!row;
  }

  markProcessed(accountEmail: string, label: string, messageId: string, internalDate: number): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO processed_messages(account_email, label, message_id, internal_date, processed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(accountEmail, label, messageId, internalDate, Date.now());
  }

  pruneProcessed(accountEmail: string, label: string, lookbackDays: number): void {
    const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
    this.db.prepare('DELETE FROM processed_messages WHERE account_email=? AND label=? AND processed_at < ?').run(accountEmail, label, cutoff);
  }
}
