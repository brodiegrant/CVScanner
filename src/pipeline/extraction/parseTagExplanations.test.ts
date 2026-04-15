import { describe, expect, it } from 'vitest';
import { ExtractionParseError, parseTagExplanations } from './parseTagExplanations.js';

describe('parseTagExplanations', () => {
  it('parses accepted tag + explanation pairs', () => {
    const result = parseTagExplanations(
      `tier:2\nCandidate appears viable\nscope:core\nCore-level hardware scope\ntech:python\nEvidence of Python verification tooling`
    );

    expect(result).toEqual({
      status: 'accepted',
      tag_explanations: [
        { tag: 'tier:2', explanation: 'Candidate appears viable' },
        { tag: 'scope:core', explanation: 'Core-level hardware scope' },
        { tag: 'tech:python', explanation: 'Evidence of Python verification tooling' }
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
    expect(() => parseTagExplanations('scope:core\nOnly one pair\ntech:python')).toThrowError(
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
    expect(() => parseTagExplanations('visa:issue\nRequires visa\nvisa:no_issues\nNo immigration issue')).toThrowError(
      /INVALID_CARDINALITY|Invalid tag set/
    );
  });

  it('reject mode must only contain two non-empty lines', () => {
    expect(() => parseTagExplanations('reject\nNot enough detail\ntech:python\nextra')).toThrowError(
      /Reject mode only allows 2 non-empty lines/
    );
  });

  it('marks blank lines as contract deviation', () => {
    expect(() => parseTagExplanations('tier:2\nValid tier\n\nscope:core\nValid scope')).toThrowError(
      /CONTRACT_DEVIATION|blank lines/
    );
  });

  it('requires exact lowercase reject keyword', () => {
    expect(() => parseTagExplanations('Reject\nNot enough detail')).toThrowError(
      /CONTRACT_DEVIATION|must be exactly "reject"/
    );
  });
});
