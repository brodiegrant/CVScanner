import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { StoredToken, TokenStore, TokenUpdate } from '../tokenStore.js';

type EncBlob = { ciphertext: Buffer; iv: Buffer; tag: Buffer };

export function validateAndDecodeKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENC_KEY must decode to exactly 32 bytes for AES-256-GCM');
  return key;
}

export function encryptString(input: string, key: Buffer): EncBlob {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(input, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function decryptString(blob: EncBlob, key: Buffer): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.iv);
  decipher.setAuthTag(blob.tag);
  return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]).toString('utf8');
}

export class SqliteTokenStore implements TokenStore {
  private readonly db: Database.Database;
  private readonly key: Buffer;

  constructor(dbPath: string, keyB64: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.key = validateAndDecodeKey(keyB64);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        account_email TEXT PRIMARY KEY,
        access_cipher BLOB NOT NULL,
        access_iv BLOB NOT NULL,
        access_tag BLOB NOT NULL,
        refresh_cipher BLOB NOT NULL,
        refresh_iv BLOB NOT NULL,
        refresh_tag BLOB NOT NULL,
        expiry_date INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
  }

  upsert(token: StoredToken): void {
    this.mergeUpsert(token.accountEmail, {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiryDate: token.expiryDate
    });
  }

  mergeUpsert(accountEmail: string, patch: TokenUpdate): void {
    if (patch.accessToken === undefined || patch.expiryDate === undefined) {
      throw new Error('mergeUpsert requires accessToken and expiryDate');
    }

    const access = encryptString(patch.accessToken, this.key);
    const shouldReplaceRefresh = typeof patch.refreshToken === 'string' && patch.refreshToken.length > 0;
    const now = new Date().toISOString();

    if (!shouldReplaceRefresh) {
      const result = this.db.prepare(`
        UPDATE oauth_tokens
        SET access_cipher=@accessCipher,
            access_iv=@accessIv,
            access_tag=@accessTag,
            expiry_date=@expiryDate,
            updated_at=@now
        WHERE account_email=@accountEmail
      `).run({
        accountEmail,
        accessCipher: access.ciphertext,
        accessIv: access.iv,
        accessTag: access.tag,
        expiryDate: patch.expiryDate,
        now
      });

      if (result.changes === 0) {
        throw new Error('mergeUpsert requires refreshToken when creating a new token row');
      }

      return;
    }

    const refresh = encryptString(patch.refreshToken as string, this.key);

    this.db.prepare(`
      INSERT INTO oauth_tokens(account_email, access_cipher, access_iv, access_tag, refresh_cipher, refresh_iv, refresh_tag, expiry_date, created_at, updated_at)
      VALUES(@accountEmail, @accessCipher, @accessIv, @accessTag, @refreshCipher, @refreshIv, @refreshTag, @expiryDate, @now, @now)
      ON CONFLICT(account_email) DO UPDATE SET
        access_cipher=excluded.access_cipher,
        access_iv=excluded.access_iv,
        access_tag=excluded.access_tag,
        refresh_cipher=COALESCE(excluded.refresh_cipher, oauth_tokens.refresh_cipher),
        refresh_iv=COALESCE(excluded.refresh_iv, oauth_tokens.refresh_iv),
        refresh_tag=COALESCE(excluded.refresh_tag, oauth_tokens.refresh_tag),
        expiry_date=excluded.expiry_date,
        updated_at=excluded.updated_at
    `).run({
      accountEmail,
      accessCipher: access.ciphertext,
      accessIv: access.iv,
      accessTag: access.tag,
      refreshCipher: refresh.ciphertext,
      refreshIv: refresh.iv,
      refreshTag: refresh.tag,
      expiryDate: patch.expiryDate,
      now
    });
  }

  get(accountEmail: string): StoredToken | null {
    const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE account_email = ?').get(accountEmail) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      accountEmail,
      accessToken: decryptString({
        ciphertext: row.access_cipher as Buffer,
        iv: row.access_iv as Buffer,
        tag: row.access_tag as Buffer
      }, this.key),
      refreshToken: decryptString({
        ciphertext: row.refresh_cipher as Buffer,
        iv: row.refresh_iv as Buffer,
        tag: row.refresh_tag as Buffer
      }, this.key),
      expiryDate: Number(row.expiry_date)
    };
  }
}
