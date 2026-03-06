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
    expect(result.transformation_audit.length).toBeGreaterThanOrEqual(3);
    expect(result.transformation_audit[0]?.stepName).toBe('normalize_unicode');
    expect(result.value_provenance.find((entry) => entry.fieldPath === 'clean_text')?.transformationType).toBe('normalized');
    expect(result.value_provenance.find((entry) => entry.fieldPath === 'signals.confidence')?.transformationType).toBe('derived');
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
    expect(result.value_provenance.find((entry) => entry.fieldPath === 'raw_text')?.cleanedValue).toBe('   ');
  });

  it('keeps provenance after JSON serialization', () => {
    const result = runCleaningPipeline({
      raw_text: 'Candidate\nemail@example.com',
      provenance: testProvenance('m-3'),
      message_id: 'm-3'
    });

    const revived = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(revived.transformation_audit[1]?.stepName).toBe('normalize_whitespace');
    expect(revived.value_provenance.some((entry) => entry.fieldPath === 'pii.email_count')).toBe(true);
  });
});
