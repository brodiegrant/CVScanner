import { describe, expect, it } from 'vitest';
import { ExtractionParseError, parseTagExplanations } from './parseTagExplanations.js';

describe('parseTagExplanations', () => {
  it('parses accepted tag + explanation pairs', () => {
    const result = parseTagExplanations(
      `tier:t2\nCandidate appears viable\nscope:remote\nRole can be done remotely\ntech:backend\nRequires backend experience`
    );

    expect(result).toEqual({
      status: 'accepted',
      tag_explanations: [
        { tag: 'tier:t2', explanation: 'Candidate appears viable' },
        { tag: 'scope:remote', explanation: 'Role can be done remotely' },
        { tag: 'tech:backend', explanation: 'Requires backend experience' }
      ]
    });
  });

  it('parses reject mode with reason', () => {
    const result = parseTagExplanations('reject\nInsufficient information to classify the posting');

    expect(result).toEqual({
      status: 'rejected',
      tag_explanations: [],
      rejection_reason: 'Insufficient information to classify the posting'
    });
  });

  it('rejects uneven line counts in accepted mode', () => {
    expect(() => parseTagExplanations('scope:remote\nOnly one pair\ntech:backend')).toThrowError(
      new ExtractionParseError(
        'UNEVEN_LINE_COUNT',
        'Accepted mode requires an even number of non-empty lines (tag + explanation pairs)'
      )
    );
  });

  it('rejects malformed tags with deterministic error code', () => {
    try {
      parseTagExplanations('invalid\nSome reason');
      throw new Error('Expected parseTagExplanations to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ExtractionParseError);
      expect((error as ExtractionParseError).code).toBe('INVALID_TAG');
      expect((error as ExtractionParseError).line).toBe(1);
    }
  });

  it('rejects non-singleton prefixes that violate cardinality rules', () => {
    expect(() => parseTagExplanations('visa:required\nRequires visa\nvisa:sponsored\nOffers sponsorship')).toThrowError(
      /INVALID_CARDINALITY|Invalid tag set/
    );
  });

  it('reject mode must only contain two non-empty lines', () => {
    expect(() => parseTagExplanations('reject\nNot enough detail\ntech:backend\nextra')).toThrowError(
      /Reject mode only allows 2 non-empty lines/
    );
  });
});
