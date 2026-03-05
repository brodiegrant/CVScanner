import { describe, expect, it, afterEach } from 'vitest';
import nock from 'nock';
import { google } from 'googleapis';
import { GmailClient } from '../src/gmail/client/gmailClient.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

afterEach(() => nock.cleanAll());

describe('GmailClient with mocked Gmail API', () => {
  it('lists metadata and downloads attachments', async () => {
    nock('https://gmail.googleapis.com')
      .get('/gmail/v1/users/me/messages')
      .query(true)
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
    expect(meta.bodyText).toContain('answer 1');

    const atts = await client.getAttachments('m1', ['pdf'], true);
    expect(atts[0].filename).toBe('cv.pdf');
    expect(atts[0].data?.toString('utf8')).toBe('pdfbytes');
  });
});
