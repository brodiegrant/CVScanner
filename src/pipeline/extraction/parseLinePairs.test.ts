import { describe, expect, it } from 'vitest';
import { ParseLinePairsError, parseLinePairs } from './parseLinePairs.js';

describe('parseLinePairs', () => {
  it('parses accepted tag + explanation pairs', () => {
    const result = parseLinePairs(`tier:t2\nHigh leverage role\nscope:remote\nRole can be done remotely`);

    expect(result).toEqual({
      status: 'accepted',
      items: [
        { tag: 'tier:t2', explanation: 'High leverage role' },
        { tag: 'scope:remote', explanation: 'Role can be done remotely' }
      ]
    });
  });

  it('parses reject mode with reason', () => {
    const result = parseLinePairs('reject\nInsufficient information to classify the posting');

    expect(result).toEqual({
      status: 'rejected',
      items: [],
      rejectionReason: 'Insufficient information to classify the posting'
    });
  });

  it('rejects uneven line counts in accepted mode', () => {
    expect(() => parseLinePairs('tier:t2\nOnly one pair\ntech:typescript')).toThrowError(
      new ParseLinePairsError(
        'UNEVEN_LINE_COUNT',
        'Accepted mode requires an even number of non-empty lines (tag + explanation pairs)'
      )
    );
  });

  it('rejects malformed tags with deterministic error code', () => {
    try {
      parseLinePairs('invalid\nSome reason');
      throw new Error('Expected parseLinePairs to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseLinePairsError);
      expect((error as ParseLinePairsError).code).toBe('INVALID_TAG');
      expect((error as ParseLinePairsError).line).toBe(1);
    }
  });

  it('rejects non-singleton prefixes that violate cardinality rules', () => {
    expect(() => parseLinePairs('tier:t1\nLikely match\ntier:t2\nConflicting tier')).toThrowError(
      /INVALID_CARDINALITY|Invalid tag set/
    );
  });

  it('reject mode must only contain two non-empty lines', () => {
    expect(() => parseLinePairs('reject\nNot enough detail\ntech:typescript\nextra')).toThrowError(
      /Reject mode only allows 2 non-empty lines/
    );
  });
});
