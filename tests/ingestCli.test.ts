import { describe, expect, it } from 'vitest';
import { getSummaryErrorMessage } from '../src/cli/ingest.js';

describe('ingest CLI summary error handling', () => {
  it('returns undefined when summary has no errors', () => {
    expect(getSummaryErrorMessage({ errors: [] })).toBeUndefined();
  });

  it('includes first error code/stage/message when summary has errors', () => {
    const message = getSummaryErrorMessage({
      errors: [
        { code: 'FATAL_INGEST', stage: 'ingest', message: 'download failed' },
        { code: 'OTHER', stage: 'parse', message: 'ignored for log line' }
      ]
    });

    expect(message).toContain('2 error(s)');
    expect(message).toContain('FATAL_INGEST/ingest download failed');
  });
});
