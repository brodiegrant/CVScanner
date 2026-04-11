import { describe, expect, it } from 'vitest';
import { parseExtractionResult, parseTagExplanationLines, sortExtractionTags } from './extractionResult.js';

describe('ExtractionResultSchema', () => {
  it('accepts valid full outputs with explanations', () => {
    const result = parseExtractionResult({
      tags: ['scope:global', 'signal:urgent', 'seniority:mid', 'tier:t2', 'tech:backend', 'location:London, UK'],
      explanations: {
        'scope:global': 'Role influences global roadmap',
        'signal:urgent': 'Posting asks for immediate availability',
        'seniority:mid': 'Experience asks for 3-5 years',
        'tier:t2': 'Maps to mid-level engineering roles',
        'tech:backend': 'Primary responsibilities are API services',
        'location:London, UK': 'Job ad lists London office'
      },
      location: null,
      warnings: ['missing salary']
    });

    expect(result.tags).toEqual([
      'location:London, UK',
      'scope:global',
      'seniority:mid',
      'signal:urgent',
      'tech:backend',
      'tier:t2'
    ]);
  });

  it('rejects malformed line pairs', () => {
    expect(() => parseTagExplanationLines(['tier:t1', 'good fit', 'seniority:mid'])).toThrow(/line pairs/);
  });

  it('rejects duplicate invalid single-value tags', () => {
    expect(() => parseExtractionResult({
      tags: ['tier:t1', 'visa:required', 'visa:sponsored'],
      explanations: {
        'tier:t1': 'Entry-level role',
        'visa:required': 'Needs work authorization',
        'visa:sponsored': 'Mentions sponsorship'
      },
      location: null
    })).toThrow(/At most one visa:\* tag is allowed/);
  });

  it('requires exactly one tier tag for non-reject output', () => {
    expect(() => parseExtractionResult({
      tags: ['seniority:mid', 'tech:backend'],
      explanations: {
        'seniority:mid': '3-5 years requested',
        'tech:backend': 'Role is backend focused'
      },
      location: null
    })).toThrow(/Exactly one tier:\* tag is required/);
  });

  it('supports reject mode behavior', () => {
    const result = parseExtractionResult({
      tags: ['tier:reject', 'signal:low-confidence'],
      explanations: {
        'tier:reject': 'Posting is spam or unrelated to hiring',
        'signal:low-confidence': 'Insufficient details in source text'
      },
      location: null
    });

    expect(result.tags).toContain('tier:reject');
  });

  it('requires explanation for each emitted tag', () => {
    expect(() => parseExtractionResult({
      tags: ['tier:t2', 'tech:backend'],
      explanations: {
        'tier:t2': 'Mid-level role'
      },
      location: null
    })).toThrow(/Missing explanation/);
  });

  it('sortExtractionTags validates before sorting', () => {
    expect(sortExtractionTags(['signal:urgent', 'signal:urgent', 'scope:remote'])).toEqual([
      'scope:remote',
      'signal:urgent'
    ]);
  });
});
