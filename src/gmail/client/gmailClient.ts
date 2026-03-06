import { gmail_v1, google } from 'googleapis';

export type MessageMetadata = {
  messageId: string;
  threadId?: string;
  internalDate: number;
  from?: string;
  to?: string;
  subject?: string;
  snippet?: string;
  bodyText?: string;
  bodyCharCount?: number;
  bodyTruncated?: boolean;
};

export type AttachmentMetadata = {
  attachmentId: string;
  filename: string;
  mimeType?: string;
  size?: number;
  data?: Buffer;
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

function normalizeBody(plain: string, html: string, maxChars: number): { bodyText: string; bodyCharCount: number; bodyTruncated: boolean } {
  const source = plain || htmlToText(html);
  const normalized = source.replace(/\s+/g, ' ').trim();
  const truncated = normalized.length > maxChars;
  const bodyText = truncated ? normalized.slice(0, maxChars) : normalized;
  return { bodyText, bodyCharCount: normalized.length, bodyTruncated: truncated };
}

function extensionAllowed(filename: string, allow: string[]): boolean {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return false;
  return allow.includes(filename.slice(idx + 1).toLowerCase());
}

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
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        labelIds: [resolvedLabelId],
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
      from: header(msg.payload?.headers, 'from'),
      to: header(msg.payload?.headers, 'to'),
      subject: header(msg.payload?.headers, 'subject'),
      snippet: msg.snippet ?? undefined
    };
    if (!includeBody) return base;
    const { plain, html } = extractBody(msg.payload);
    const norm = normalizeBody(plain, html, maxChars);
    return { ...base, ...norm };
  }

  async getAttachments(messageId: string, allowExtensions: string[], downloadBytes: boolean): Promise<AttachmentMetadata[]> {
    const res = await this.gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    const out: AttachmentMetadata[] = [];
    const parts = [...(res.data.payload?.parts ?? [])];
    while (parts.length > 0) {
      const part = parts.shift()!;
      if (part.parts) parts.push(...part.parts);
      const attachmentId = part.body?.attachmentId;
      const filename = part.filename ?? '';
      if (!attachmentId || !filename || !extensionAllowed(filename, allowExtensions)) continue;
      const meta: AttachmentMetadata = { attachmentId, filename, mimeType: part.mimeType ?? undefined, size: part.body?.size ?? undefined };
      if (downloadBytes) {
        const att = await this.gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
        meta.data = Buffer.from((att.data.data ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      }
      out.push(meta);
    }
    return out;
  }
}
