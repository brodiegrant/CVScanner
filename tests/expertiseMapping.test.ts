import { describe, expect, it } from 'vitest';
import {
  assertExpertiseMappingConfig,
  mapTagsToExpertiseLinks,
  type ExpertiseMappingResult
} from '../src/vincere/expertiseMapping.js';

describe('expertise mapping config', () => {
  it('validates required mappings at startup', () => {
    expect(() => assertExpertiseMappingConfig()).not.toThrow();
  });
});

describe('mapTagsToExpertiseLinks', () => {
  it('aggregates multiple tags into grouped expertise items with stable ordering', () => {
    const result = mapTagsToExpertiseLinks([
      'tech:python',
      'tech:uvm',
      'design:cpu',
      'tech:systemverilog',
      'tech:uvm'
    ]);

    expect(result).toEqual<ExpertiseMappingResult>({
      items: [
        { func_id: 200, sub_func_ids: [2001, 2002, 2005] },
        { func_id: 202, sub_func_ids: [2201] }
      ],
      unknownTags: [],
      manualReviewReason: null
    });
  });

  it('returns deterministic unknown tags and manual review reason for unmapped input', () => {
    const result = mapTagsToExpertiseLinks(['tech:python', 'scope:global', 'unknown:value', 'scope:global']);

    expect(result).toEqual<ExpertiseMappingResult>({
      items: [{ func_id: 200, sub_func_ids: [2005] }],
      unknownTags: ['scope:global', 'unknown:value'],
      manualReviewReason: 'UNMAPPED_EXPERTISE_TAGS:scope:global,unknown:value'
    });
  });

  it('normalizes case and whitespace before mapping', () => {
    const result = mapTagsToExpertiseLinks([' Tech:SystemVerilog ', 'tech:python']);

    expect(result).toEqual<ExpertiseMappingResult>({
      items: [{ func_id: 200, sub_func_ids: [2001, 2005] }],
      unknownTags: [],
      manualReviewReason: null
    });
  });
});
