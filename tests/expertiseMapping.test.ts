import { describe, expect, it } from 'vitest';
import {
  assertExpertiseMappingConfig,
  mapTagsToExpertiseLinks,
  type ExpertiseMappingResult
} from '../src/vincere/expertiseMapping.js';

describe('expertise mapping config', () => {
  it('validates at startup', () => {
    expect(() => assertExpertiseMappingConfig()).not.toThrow();
  });
});

describe('mapTagsToExpertiseLinks', () => {
  it('aggregates multiple tags into grouped expertise items with stable ordering', () => {
    const result = mapTagsToExpertiseLinks([
      'tech:backend',
      'tech:frontend',
      'design:ux',
      'tech:fullstack',
      'tech:backend'
    ]);

    expect(result).toEqual<ExpertiseMappingResult>({
      items: [
        { func_id: 100, sub_func_ids: [1001, 1002] },
        { func_id: 103, sub_func_ids: [1033] }
      ],
      unknownTags: [],
      manualReviewReason: null
    });
  });

  it('returns deterministic unknown tags and manual review reason for unmapped input', () => {
    const result = mapTagsToExpertiseLinks(['tech:ai', 'signal:strong', 'unknown:value', 'signal:strong']);

    expect(result).toEqual<ExpertiseMappingResult>({
      items: [{ func_id: 101, sub_func_ids: [1013] }],
      unknownTags: ['signal:strong', 'unknown:value'],
      manualReviewReason: 'UNMAPPED_EXPERTISE_TAGS:signal:strong,unknown:value'
    });
  });

  it('normalizes case and whitespace before mapping', () => {
    const result = mapTagsToExpertiseLinks([' Tech:ML ', 'tech:data']);

    expect(result).toEqual<ExpertiseMappingResult>({
      items: [{ func_id: 101, sub_func_ids: [1011, 1012] }],
      unknownTags: [],
      manualReviewReason: null
    });
  });
});
