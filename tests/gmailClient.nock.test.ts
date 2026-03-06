import { describe, expect, it, afterEach } from 'vitest';
import nock from 'nock';
import { google } from 'googleapis';
import { GmailClient } from '../src/gmail/client/gmailClient.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

afterEach(() => nock.cleanAll());

describe('GmailClient with mocked Gmail API', () => {
  it('resolves label names and downloads attachments', async () => {
    nock('https://gmail.googleapis.com')
      .get('/gmail/v1/users/me/labels')
      .reply(200, { labels: [{ id: 'Label_123', name: 'Process' }] });

    nock('https://gmail.googleapis.com')
      .get('/gmail/v1/users/me/labels')
      .query(true)
      .reply(200, { labels: [{ id: 'Label_123', name: 'Process' }] });

    nock('https://gmail.googleapis.com')
      .get('/gmail/v1/users/me/labels/Label_123')
      .query(true)
      .reply(200, { id: 'Label_123', name: 'Process' });

    nock('https://gmail.googleapis.com')
      .get('/gmail/v1/users/me/messages')
      .query((q) => q.labelIds === 'Label_123' && q.maxResults === '100')
      .reply(200, { messages: [{ id: 'm1' }] });

    nock('https://gmail.googleapis.com')
      .get('/gmail/v1/users/me/messages/m1')
      .query((q) => q.format === 'full')
      .times(2)
      .reply(200, {
        id: 'm1',
        threadId: 't1',
        internalDate: '1000',
        snippet: 'snip',
        payload: {
          headers: [{ name: 'From', value: 'a@test.com' }, { name: 'Subject', value: 'Hi' }],
          parts: [
            { mimeType: 'text/plain', body: { data: b64('answer 1') } },
            { filename: 'cv.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att1', size: 12 } }
          ]
        }
      });

    nock('https://gmail.googleapis.com')
      .get('/gmail/v1/users/me/messages/m1/attachments/att1')
      .reply(200, { data: b64('pdfbytes') });

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: 'token' });
    const client = new GmailClient(auth);

    const ids = await client.listMessageIds('Process', 0);
    expect(ids).toEqual(['m1']);

    const meta = await client.getMessageMetadata('m1', true, 1000);
    expect(meta.rawBodyCandidate).toContain('answer 1');
    expect(meta.normalizedBodyCandidate).toContain('answer 1');
    expect(meta.bodyExtractionSource).toBe('text/plain');

    const atts = await client.getAttachments('m1', {
      maxBytes: 1024,
      allowedMimeTypes: ['application/pdf'],
      allowedExtensions: ['pdf'],
      allowArchives: false,
      maxArchiveExpansionRatio: 30
    }, true);
    const accepted = atts.find((a) => !a.rejected);
    expect(accepted?.filename).toBe('cv.pdf');
    expect(accepted?.data?.toString('utf8')).toBe('pdfbytes');
  });


  it('rejects disallowed attachments using metadata before downloading bytes', async () => {
    nock('https://gmail.googleapis.com')
      .get('/gmail/v1/users/me/messages/m2')
      .query((q) => q.format === 'full')
      .once()
      .reply(200, {
        id: 'm2',
        payload: {
          parts: [
            { filename: 'resume.zip', mimeType: 'application/zip', body: { attachmentId: 'zip1', size: 99 } },
            { filename: 'resume.pdf', mimeType: 'application/pdf', body: { attachmentId: 'pdf1', size: 999999 } }
          ]
        }
      });

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: 'token' });
    const client = new GmailClient(auth);

    const atts = await client.getAttachments('m2', {
      maxBytes: 1024,
      allowedMimeTypes: ['application/pdf'],
      allowedExtensions: ['pdf'],
      allowArchives: false,
      maxArchiveExpansionRatio: 30
    }, true);

    expect(atts).toHaveLength(2);
    expect(atts[0].rejected).toBe(true);
    expect(atts[0].rejectReason).toBe('archive_not_allowed');
    expect(atts[1].rejected).toBe(true);
    expect(atts[1].rejectReason).toBe('size_exceeds_max_bytes');
    expect(nock.isDone()).toBe(true);
  });



  it('listMessageIds uses the resolved Gmail label id in users.messages.list', async () => {
    nock('https://gmail.googleapis.com')
      .get('/gmail/v1/users/me/labels')
      .query(true)
      .once()
      .reply(200, { labels: [{ id: 'Label_Resolved_42', name: 'Hiring Queue' }] });

    nock('https://gmail.googleapis.com')
      .get('/gmail/v1/users/me/labels/Label_Resolved_42')
      .query(true)
      .once()
      .reply(200, { id: 'Label_Resolved_42', name: 'Hiring Queue' });

    nock('https://gmail.googleapis.com')
      .get('/gmail/v1/users/me/messages')
      .query((q) => q.labelIds === 'Label_Resolved_42' && q.q === 'after:1' && q.maxResults === '100')
      .once()
      .reply(200, { messages: [{ id: 'm42' }] });

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: 'token' });
    const client = new GmailClient(auth);

    await expect(client.listMessageIds('Hiring Queue', 1000)).resolves.toEqual(['m42']);
    expect(nock.isDone()).toBe(true);
  });

  it('resolves configured label name to id once and reuses cached id', async () => {
    nock('https://gmail.googleapis.com')
      .get('/gmail/v1/users/me/labels')
      .query(true)
      .once()
      .reply(200, { labels: [{ id: 'Label_999', name: 'Custom Queue' }] });

    nock('https://gmail.googleapis.com')
      .get('/gmail/v1/users/me/labels/Label_999')
      .query(true)
      .once()
      .reply(200, { id: 'Label_999', name: 'Custom Queue' });

    nock('https://gmail.googleapis.com')
      .get('/gmail/v1/users/me/messages')
      .query((q) => q.labelIds === 'Label_999' && q.q === 'after:0')
      .twice()
      .reply(200, { messages: [{ id: 'm1' }] });

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: 'token' });
    const client = new GmailClient(auth);

    await expect(client.listMessageIds('Custom Queue', 0)).resolves.toEqual(['m1']);
    await expect(client.listMessageIds('Custom Queue', 0)).resolves.toEqual(['m1']);

    expect(nock.isDone()).toBe(true);
  });

  it('falls back to html body extraction and reports source', async () => {
    nock('https://gmail.googleapis.com')
      .get('/gmail/v1/users/me/messages/m-html')
      .query((q) => q.format === 'full')
      .once()
      .reply(200, {
        id: 'm-html',
        internalDate: '1000',
        payload: {
          parts: [
            { mimeType: 'text/html', body: { data: b64('<p>Hello&nbsp;&nbsp;world</p>') } }
          ]
        }
      });

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: 'token' });
    const client = new GmailClient(auth);

    const meta = await client.getMessageMetadata('m-html', true, 1000);
    expect(meta.bodyExtractionSource).toBe('text/html-fallback');
    expect(meta.rawBodyCandidate).toContain('Hello');
    expect(meta.normalizedBodyCandidate).toBe('Hello&nbsp;&nbsp;world');
  });
});
