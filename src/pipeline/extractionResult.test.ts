import { describe, expect, it } from 'vitest';
import { parseExtractionResult, sortExtractionTags } from './extractionResult.js';

describe('ExtractionResultSchema', () => {
  it('dedupes and sorts tags deterministically', () => {
    const result = parseExtractionResult({
      tags: ['scope:global', 'signal:urgent', 'scope:global', 'seniority:mid', 'signal:strong'],
      location: null,
      warnings: ['missing salary']
    });

    expect(result.tags).toEqual([
      'scope:global',
      'seniority:mid',
      'signal:strong',
      'signal:urgent'
    ]);
  });

  it('rejects tags outside the approved vocabulary', () => {
    expect(() => parseExtractionResult({
      tags: ['location:london'],
      location: null
    })).toThrow(/approved vocabulary/);
  });

  it('rejects multiple visa tags', () => {
    expect(() => parseExtractionResult({
      tags: ['visa:required', 'visa:sponsored'],
      location: null
    })).toThrow(/At most one visa:\* tag is allowed/);
  });

  it('accepts structured locations', () => {
    const result = parseExtractionResult({
      tags: ['tech:typescript', 'scope:remote'],
      location: {
        city: 'London',
        country: 'United Kingdom',
        latitude: 51.5072,
        longitude: -0.1276,
        location_name: 'London HQ'
      },
      promptVersion: 'v1',
      modelName: 'gpt-5.2'
    });

    expect(result.location?.city).toBe('London');
    expect(result.location?.location_name).toBe('London HQ');
  });

  it('sortExtractionTags validates before sorting', () => {
    expect(sortExtractionTags(['signal:alpha', 'signal:alpha', 'scope:emea'])).toEqual([
      'scope:emea',
      'signal:alpha'
    ]);
  });
});
