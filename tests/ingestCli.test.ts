import { describe, expect, it } from 'vitest';
import { getSummaryErrorMessage } from '../src/cli/ingest.js';

describe('ingest CLI summary error handling', () => {
  it('returns undefined when summary has no errors', () => {
    expect(getSummaryErrorMessage({ errors: [] })).toBeUndefined();
  });

  it('includes first error kind/stage/message when summary has errors', () => {
    const message = getSummaryErrorMessage({
      errors: [
        { kind: 'ExtractionFailedError', stage: 'ingest', messageId: 'm-1', message: 'download failed' },
        { kind: 'BodyMissingError', stage: 'cleaning', messageId: 'm-2', message: 'ignored for log line' }
      ]
    });

    expect(message).toContain('2 error(s)');
    expect(message).toContain('ExtractionFailedError/ingest download failed');
  });
});
