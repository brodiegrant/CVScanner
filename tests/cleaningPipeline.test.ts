import { describe, expect, it } from 'vitest';
import { runCleaningPipeline } from '../src/pipeline/cleaning/pipeline.js';
import { buildIngestProvenance } from '../src/pipeline/provenance.js';

function testProvenance(messageId: string) {
  return buildIngestProvenance({
    runId: 'run-1',
    accountEmail: 'scanner@example.com',
    label: 'Process',
    messageId,
    internalDate: 123,
    screeningSourceText: 'resume body',
    attachments: []
  });
}

describe('cleaning pipeline', () => {
  it('normalizes text, strips boilerplate, and emits signals/pii', () => {
    const result = runCleaningPipeline({
      raw_text: 'José  Candidate\r\n\r\nBest regards,\njose@example.com\n(415) 555-1212',
      provenance: testProvenance('m-1'),
      message_id: 'm-1'
    });

    expect(result.clean_text).not.toContain('Best regards');
    expect(result.body_text).toContain('Candidate');
    expect(result.pii.contains_email).toBe(true);
    expect(result.pii.contains_phone).toBe(true);
    expect(result.signals.raw_length).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
  });

  it('adds an error when raw text is empty', () => {
    const result = runCleaningPipeline({
      raw_text: '   ',
      provenance: testProvenance('m-2'),
      message_id: 'm-2'
    });

    expect(result.errors).toContainEqual({
      kind: 'BodyMissingError',
      stage: 'cleaning',
      messageId: 'm-2',
      message: 'raw_text is empty after trimming'
    });
  });
});
