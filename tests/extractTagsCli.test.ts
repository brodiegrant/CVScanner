import { describe, expect, it } from 'vitest';
import { normalizeParsedOutput, parseCliArgs, runExtractionService } from '../src/cli/extract-tags.js';

describe('extract-tags CLI helpers', () => {
  it('parses --file and --raw flags', () => {
    expect(parseCliArgs(['--file=/tmp/input.txt', '--raw'])).toEqual({
      file: '/tmp/input.txt',
      raw: true
    });
  });

  it('normalizes accepted parser output', () => {
    const normalized = normalizeParsedOutput(
      'tech:backend\nBackend fit\ntier:t2\nTier rationale\nscope:remote\nRemote rationale'
    );

    expect(normalized).toEqual({
      status: 'accepted',
      tags: ['scope:remote', 'tech:backend', 'tier:t2'],
      explanations: {
        'tech:backend': 'Backend fit',
        'tier:t2': 'Tier rationale',
        'scope:remote': 'Remote rationale'
      }
    });
  });

  it('normalizes rejected parser output', () => {
    expect(normalizeParsedOutput('reject\nNot enough signal')).toEqual({
      status: 'rejected',
      tags: [],
      explanations: {},
      rejection_reason: 'Not enough signal'
    });
  });

  it('throws model error for empty extraction input', async () => {
    await expect(runExtractionService(' \n\t ')).rejects.toThrow('Model error: empty input');
  });
});
