import { gmail_v1, google } from 'googleapis';

export type MessageMetadata = {
  messageId: string;
  threadId?: string;
  internalDate: number;
  from?: string;
  to?: string;
  subject?: string;
  snippet?: string;
  rawBodyCandidate?: string;
  normalizedBodyCandidate?: string;
  bodyExtractionSource?: 'text/plain' | 'text/html-fallback';
  bodyCharCount?: number;
  bodyTruncated?: boolean;
};

export type AttachmentRejectReason =
  | 'missing_filename'
  | 'missing_attachment_id'
  | 'size_exceeds_max_bytes'
  | 'mime_not_allowed'
  | 'extension_not_allowed'
  | 'archive_not_allowed'
  | 'archive_expansion_ratio_unknown'
  | 'archive_expansion_ratio_exceeded';

export type AttachmentPolicy = {
  maxBytes: number;
  allowedMimeTypes: string[];
  allowedExtensions: string[];
  allowArchives: boolean;
  maxArchiveExpansionRatio: number;
};

export type AttachmentMetadata = {
  attachmentId?: string;
  filename: string;
  mimeType?: string;
  size?: number;
  data?: Buffer;
  rejected: boolean;
  rejectReason?: AttachmentRejectReason;
};

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, key: string) {
  return headers?.find((h) => h.name?.toLowerCase() === key.toLowerCase())?.value;
}

function decodeBody(data?: string | null): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function htmlToText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ');
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): { plain: string; html: string } {
  if (!payload) return { plain: '', html: '' };
  const queue = [payload];
  let plain = '';
  let html = '';
  while (queue.length > 0) {
    const part = queue.shift()!;
    if (part.mimeType === 'text/plain') plain += `\n${decodeBody(part.body?.data)}`;
    if (part.mimeType === 'text/html') html += `\n${decodeBody(part.body?.data)}`;
    if (part.parts) queue.push(...part.parts);
  }
  return { plain: plain.trim(), html: html.trim() };
}

function normalizeBody(
  plain: string,
  html: string,
  maxChars: number
): {
  rawBodyCandidate: string;
  normalizedBodyCandidate: string;
  bodyExtractionSource: 'text/plain' | 'text/html-fallback';
  bodyCharCount: number;
  bodyTruncated: boolean;
} {
  const bodyExtractionSource = plain ? 'text/plain' : 'text/html-fallback';
  const rawBodyCandidate = plain || htmlToText(html);
  const normalized = rawBodyCandidate.replace(/\s+/g, ' ').trim();
  const truncated = normalized.length > maxChars;
  const normalizedBodyCandidate = truncated ? normalized.slice(0, maxChars) : normalized;
  return { rawBodyCandidate, normalizedBodyCandidate, bodyExtractionSource, bodyCharCount: normalized.length, bodyTruncated: truncated };
}

function extensionAllowed(filename: string, allow: string[]): boolean {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return false;
  return allow.includes(filename.slice(idx + 1).toLowerCase());
}

function isArchiveMime(mimeType?: string): boolean {
  if (!mimeType) return false;
  const normalized = mimeType.toLowerCase();
  return normalized === 'application/zip' || normalized === 'application/x-zip-compressed' || normalized === 'multipart/x-zip';
}

function isArchiveFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith('.zip');
}

function shouldAllowByMimeOrExtension(meta: { filename: string; mimeType?: string }, policy: AttachmentPolicy): AttachmentRejectReason | undefined {
  const mime = meta.mimeType?.toLowerCase();
  const archive = isArchiveMime(mime) || isArchiveFilename(meta.filename);

  if (archive && !policy.allowArchives) return 'archive_not_allowed';
  if (archive && policy.allowArchives) return undefined;

  if (mime && policy.allowedMimeTypes.includes(mime)) return undefined;

  // Extension allowlist is secondary heuristic for missing/generic MIME.
  if (!mime || mime === 'application/octet-stream') {
    return extensionAllowed(meta.filename, policy.allowedExtensions) ? undefined : 'extension_not_allowed';
  }

  return 'mime_not_allowed';
}

function computeZipExpansionRatio(data: Buffer): number | undefined {
  const CDFH_SIGNATURE = 0x02014b50;
  let offset = 0;
  let compressedTotal = 0;
  let uncompressedTotal = 0;

  while (offset + 46 <= data.length) {
    const signature = data.readUInt32LE(offset);
    if (signature !== CDFH_SIGNATURE) {
      offset += 1;
      continue;
    }

    const compressed = data.readUInt32LE(offset + 20);
    const uncompressed = data.readUInt32LE(offset + 24);
    const filenameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);

    // Zip64 or unknown values are unsupported in this lightweight parser.
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) return undefined;

    compressedTotal += compressed;
    uncompressedTotal += uncompressed;

    const next = offset + 46 + filenameLength + extraLength + commentLength;
    if (next <= offset) return undefined;
    offset = next;
  }

  if (compressedTotal <= 0) return undefined;
  return uncompressedTotal / compressedTotal;
}

const SYSTEM_LABELS = new Set(['INBOX', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']);

export class GmailClient {
  private gmail: gmail_v1.Gmail;
  private resolvedLabelIds = new Map<string, string>();

  constructor(auth: any) {
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  async resolveLabelId(label: string): Promise<string> {
    const configuredLabel = label.trim();
    const cached = this.resolvedLabelIds.get(configuredLabel);
    if (cached) return cached;

    const listRes = await this.gmail.users.labels.list({ userId: 'me' });
    const labels = listRes.data.labels ?? [];
    const directMatch = labels.find((entry) => entry.id === configuredLabel);
    const nameMatch = labels.find((entry) => entry.name === configuredLabel);
    const caseInsensitiveNameMatch = labels.find((entry) => entry.name?.toLowerCase() === configuredLabel.toLowerCase());
    const candidateId = directMatch?.id ?? nameMatch?.id ?? caseInsensitiveNameMatch?.id;
    if (!candidateId) {
      throw new Error(`Gmail label not found: ${configuredLabel}`);
    }

    const labelRes = await this.gmail.users.labels.get({ userId: 'me', id: candidateId });
    const resolvedId = labelRes.data.id ?? candidateId;
    this.resolvedLabelIds.set(configuredLabel, resolvedId);
    if (labelRes.data.name) this.resolvedLabelIds.set(labelRes.data.name, resolvedId);
    this.resolvedLabelIds.set(resolvedId, resolvedId);
    return resolvedId;
  }

  async listMessageIds(label: string, afterInternalDateMs: number): Promise<string[]> {
    // Gmail search `after:` operates at second precision, so callers should pass
    // a bounded overlap window (not an exact previous cursor) to avoid missing
    // messages around second-level boundaries.
    const afterSec = Math.floor(afterInternalDateMs / 1000);
    const q = `after:${afterSec}`;
    const labelId = await this.resolveLabelId(label);
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        labelIds: [labelId],
        q,
        maxResults: 100,
        pageToken
      });
      ids.push(...(res.data.messages?.map((m) => m.id!).filter(Boolean) ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return ids;
  }

  async getMessageMetadata(messageId: string, includeBody: boolean, maxChars: number): Promise<MessageMetadata> {
    const res = await this.gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    const msg = res.data;
    const base: MessageMetadata = {
      messageId: msg.id!,
      threadId: msg.threadId ?? undefined,
      internalDate: Number(msg.internalDate ?? '0'),
      from: header(msg.payload?.headers, 'from') ?? undefined,
      to: header(msg.payload?.headers, 'to') ?? undefined,
      subject: header(msg.payload?.headers, 'subject') ?? undefined,
      snippet: msg.snippet ?? undefined
    };
    if (!includeBody) return base;
    const { plain, html } = extractBody(msg.payload);
    const norm = normalizeBody(plain, html, maxChars);
    return { ...base, ...norm };
  }

  async getAttachments(messageId: string, policy: AttachmentPolicy, downloadBytes: boolean): Promise<AttachmentMetadata[]> {
    const res = await this.gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    const out: AttachmentMetadata[] = [];
    const parts = [...(res.data.payload?.parts ?? [])];
    while (parts.length > 0) {
      const part = parts.shift()!;
      if (part.parts) parts.push(...part.parts);
      const attachmentId = part.body?.attachmentId;
      const filename = part.filename ?? '';
      const mimeType = part.mimeType ?? undefined;
      const size = part.body?.size ?? undefined;

      if (!filename) {
        out.push({ filename: '', mimeType, size, rejected: true, rejectReason: 'missing_filename' });
        continue;
      }
      if (!attachmentId) {
        out.push({ filename, mimeType, size, rejected: true, rejectReason: 'missing_attachment_id' });
        continue;
      }
      if (typeof size === 'number' && size > policy.maxBytes) {
        out.push({ attachmentId, filename, mimeType, size, rejected: true, rejectReason: 'size_exceeds_max_bytes' });
        continue;
      }

      const rejectReason = shouldAllowByMimeOrExtension({ filename, mimeType }, policy);
      if (rejectReason) {
        out.push({ attachmentId, filename, mimeType, size, rejected: true, rejectReason });
        continue;
      }

      const meta: AttachmentMetadata = { attachmentId, filename, mimeType, size, rejected: false };
      if (downloadBytes) {
        const att = await this.gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
        meta.data = Buffer.from((att.data.data ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

        const isArchive = isArchiveMime(mimeType) || isArchiveFilename(filename);
        if (isArchive) {
          const ratio = computeZipExpansionRatio(meta.data);
          if (ratio === undefined) {
            meta.rejected = true;
            meta.rejectReason = 'archive_expansion_ratio_unknown';
            meta.data = undefined;
          } else if (ratio > policy.maxArchiveExpansionRatio) {
            meta.rejected = true;
            meta.rejectReason = 'archive_expansion_ratio_exceeded';
            meta.data = undefined;
          }
        }
      }
      out.push(meta);
    }
    return out;
  }
}
