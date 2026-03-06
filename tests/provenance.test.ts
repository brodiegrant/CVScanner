import { describe, expect, it } from 'vitest';
import { applyExtractionProvenance, buildIngestProvenance, withFinalCleaningOutput } from '../src/pipeline/provenance.js';

describe('pipeline provenance', () => {
  it('builds ingest provenance with message ids, timestamps, and attachment origins', () => {
    const provenance = buildIngestProvenance({
      runId: 'run-1',
      accountEmail: 'scanner@example.com',
      label: 'Process',
      messageId: 'msg-1',
      threadId: 'thread-1',
      internalDate: 123,
      ingestionTimestamp: '2025-01-01T00:00:00.000Z',
      ingestionTimezone: 'UTC',
      screeningSourceText: 'resume body',
      attachments: [{ attachmentId: 'att-1', filename: 'resume.pdf', mimeType: 'application/pdf', size: 42, data: Buffer.from('pdf-bytes') }]
    });

    expect(provenance.message.messageId).toBe('msg-1');
    expect(provenance.message.ingestionTimestamp).toBe('2025-01-01T00:00:00.000Z');
    expect(provenance.preExtractionArtifacts[1].origin.gmailAttachmentId).toBe('att-1');
    expect(provenance.preExtractionArtifacts[1].hashAlgorithm).toBe('sha256');
  });

  it('carries provenance through extraction and final cleaning output', () => {
    const ingestProvenance = buildIngestProvenance({
      runId: 'run-1',
      accountEmail: 'scanner@example.com',
      label: 'Process',
      messageId: 'msg-1',
      internalDate: 123,
      screeningSourceText: 'resume body',
      attachments: []
    });

    const extractionProvenance = applyExtractionProvenance({
      provenance: ingestProvenance,
      extractorName: 'pdf-extractor',
      extractorVersion: '1.2.3',
      extractionTimestamp: '2025-01-01T00:01:00.000Z',
      extractionTimezone: 'UTC',
      postExtractionArtifacts: [{
        artifactId: 'extracted-text',
        content: 'normalized text',
        origin: { filename: 'resume.pdf', mimeType: 'application/pdf', size: 42, gmailAttachmentId: 'att-1' }
      }]
    });

    const finalOutput = withFinalCleaningOutput({ candidateName: 'Jane Doe' }, extractionProvenance);

    expect(finalOutput.provenance.extraction?.extractorName).toBe('pdf-extractor');
    expect(finalOutput.provenance.postExtractionArtifacts[0].artifactId).toBe('extracted-text');
    expect(finalOutput.candidateName).toBe('Jane Doe');
  });
});
