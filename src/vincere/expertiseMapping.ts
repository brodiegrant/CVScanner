import { TAG_ALLOWLIST } from '../pipeline/ontology.js';
import { z } from 'zod';

const ExpertiseMappingEntrySchema = z
  .object({
    func_id: z.number().int().positive().nullable(),
    sub_func_ids: z.array(z.number().int().positive()).default([])
  })
  .superRefine((value, ctx) => {
    if (value.func_id === null && value.sub_func_ids.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sub_func_ids require a non-null func_id'
      });
    }
  });

const ExpertiseTagMapSchema = z.record(z.string().trim().min(1), ExpertiseMappingEntrySchema);

const REQUIRED_EXPERTISE_TAG_CATEGORIES = ['tech', 'proto', 'design', 'signal'] as const;

const FUNC_IDS = {
  tech: 200,
  proto: 201,
  design: 202,
  signal: 203
} as const;

export interface ExpertiseLinkPayloadItem {
  func_id: number | null;
  sub_func_ids: number[];
}

export interface ExpertiseMappingResult {
  items: ExpertiseLinkPayloadItem[];
  unknownTags: string[];
  manualReviewReason: string | null;
}

/**
 * Mapping configuration for parsed tags -> Vincere expertise links.
 *
 * Keep this as an explicit, typed constant to make changes auditable in source control.
 */
export const EXPERTISE_TAG_MAP = {
  // tech
  'tech:systemverilog': { func_id: FUNC_IDS.tech, sub_func_ids: [2001] },
  'tech:uvm': { func_id: FUNC_IDS.tech, sub_func_ids: [2002] },
  'tech:formal': { func_id: FUNC_IDS.tech, sub_func_ids: [2003] },
  'tech:cocotb': { func_id: FUNC_IDS.tech, sub_func_ids: [2004] },
  'tech:python': { func_id: FUNC_IDS.tech, sub_func_ids: [2005] },
  'tech:verilator': { func_id: FUNC_IDS.tech, sub_func_ids: [2006] },
  'tech:agentic': { func_id: FUNC_IDS.tech, sub_func_ids: [2007] },

  // proto
  'proto:axi': { func_id: FUNC_IDS.proto, sub_func_ids: [2101] },
  'proto:ahb': { func_id: FUNC_IDS.proto, sub_func_ids: [2102] },
  'proto:apb': { func_id: FUNC_IDS.proto, sub_func_ids: [2103] },
  'proto:pci': { func_id: FUNC_IDS.proto, sub_func_ids: [2104] },
  'proto:usb': { func_id: FUNC_IDS.proto, sub_func_ids: [2105] },
  'proto:ethernet': { func_id: FUNC_IDS.proto, sub_func_ids: [2106] },
  'proto:ddr': { func_id: FUNC_IDS.proto, sub_func_ids: [2107] },
  'proto:lpddr': { func_id: FUNC_IDS.proto, sub_func_ids: [2108] },
  'proto:hbm': { func_id: FUNC_IDS.proto, sub_func_ids: [2109] },
  'proto:ucie': { func_id: FUNC_IDS.proto, sub_func_ids: [2110] },
  'proto:cxl': { func_id: FUNC_IDS.proto, sub_func_ids: [2111] },
  'proto:serdes': { func_id: FUNC_IDS.proto, sub_func_ids: [2112] },
  'proto:spi': { func_id: FUNC_IDS.proto, sub_func_ids: [2113] },
  'proto:i2c': { func_id: FUNC_IDS.proto, sub_func_ids: [2114] },
  'proto:uart': { func_id: FUNC_IDS.proto, sub_func_ids: [2115] },
  'proto:mipi': { func_id: FUNC_IDS.proto, sub_func_ids: [2116] },
  'proto:can': { func_id: FUNC_IDS.proto, sub_func_ids: [2117] },
  'proto:lin': { func_id: FUNC_IDS.proto, sub_func_ids: [2118] },
  'proto:high_speed': { func_id: FUNC_IDS.proto, sub_func_ids: [2119] },

  // design
  'design:cpu': { func_id: FUNC_IDS.design, sub_func_ids: [2201] },
  'design:gpu': { func_id: FUNC_IDS.design, sub_func_ids: [2202] },
  'design:dsp': { func_id: FUNC_IDS.design, sub_func_ids: [2203] },
  'design:npu': { func_id: FUNC_IDS.design, sub_func_ids: [2204] },
  'design:cache': { func_id: FUNC_IDS.design, sub_func_ids: [2205] },
  'design:coherency': { func_id: FUNC_IDS.design, sub_func_ids: [2206] },
  'design:memory': { func_id: FUNC_IDS.design, sub_func_ids: [2207] },
  'design:ddr': { func_id: FUNC_IDS.design, sub_func_ids: [2208] },
  'design:ai_accelerator': { func_id: FUNC_IDS.design, sub_func_ids: [2209] },
  'design:fpga': { func_id: FUNC_IDS.design, sub_func_ids: [2210] },
  'design:networking': { func_id: FUNC_IDS.design, sub_func_ids: [2211] },
  'design:automotive': { func_id: FUNC_IDS.design, sub_func_ids: [2212] },
  'design:wireless': { func_id: FUNC_IDS.design, sub_func_ids: [2213] },
  'design:storage': { func_id: FUNC_IDS.design, sub_func_ids: [2214] },
  'design:multimedia': { func_id: FUNC_IDS.design, sub_func_ids: [2215] },

  // signal
  'signal:digital': { func_id: FUNC_IDS.signal, sub_func_ids: [2301] },
  'signal:analog': { func_id: FUNC_IDS.signal, sub_func_ids: [2302] },
  'signal:ams': { func_id: FUNC_IDS.signal, sub_func_ids: [2303] }
} as const;

const REQUIRED_EXPERTISE_TAGS = REQUIRED_EXPERTISE_TAG_CATEGORIES.flatMap((category) => {
  const values = TAG_ALLOWLIST[category];
  if (!Array.isArray(values)) {
    throw new Error(`Expected ontology allowlist array for category: ${category}`);
  }

  return values.map((value) => `${category}:${value}`);
});

const VALIDATED_EXPERTISE_TAG_MAP = validateExpertiseTagMap(EXPERTISE_TAG_MAP);
assertRequiredExpertiseMappings(VALIDATED_EXPERTISE_TAG_MAP, REQUIRED_EXPERTISE_TAGS);

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function stableUniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function stableUniqueTags(tags: string[]): string[] {
  return [...new Set(tags.map(normalizeTag))].sort((a, b) => a.localeCompare(b));
}

function validateExpertiseTagMap(map: unknown): Record<string, ExpertiseLinkPayloadItem> {
  const parsed = ExpertiseTagMapSchema.parse(map);
  const normalizedEntries = Object.entries(parsed).map(([tag, entry]) => [normalizeTag(tag), entry] as const);

  const dedupedMap = new Map<string, ExpertiseLinkPayloadItem>();
  for (const [tag, entry] of normalizedEntries) {
    if (dedupedMap.has(tag)) {
      throw new Error(`Duplicate expertise mapping key after normalization: ${tag}`);
    }

    dedupedMap.set(tag, {
      func_id: entry.func_id,
      sub_func_ids: stableUniqueNumbers(entry.sub_func_ids)
    });
  }

  return Object.fromEntries([...dedupedMap.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function assertRequiredExpertiseMappings(
  map: Record<string, ExpertiseLinkPayloadItem>,
  requiredTags: string[]
): void {
  const missingTags = stableUniqueTags(requiredTags).filter((tag) => map[tag] === undefined);
  if (missingTags.length > 0) {
    throw new Error(`Missing required expertise mappings for tags: ${missingTags.join(',')}`);
  }
}

export function mapTagsToExpertiseLinks(tags: string[]): ExpertiseMappingResult {
  const grouped = new Map<number | null, Set<number>>();
  const unknownTags: string[] = [];

  for (const tag of stableUniqueTags(tags)) {
    const mapping = VALIDATED_EXPERTISE_TAG_MAP[tag];

    if (!mapping) {
      unknownTags.push(tag);
      continue;
    }

    const bucket = grouped.get(mapping.func_id) ?? new Set<number>();
    for (const subFuncId of mapping.sub_func_ids) {
      bucket.add(subFuncId);
    }
    grouped.set(mapping.func_id, bucket);
  }

  const items: ExpertiseLinkPayloadItem[] = [...grouped.entries()]
    .sort(([left], [right]) => {
      if (left === null && right === null) {
        return 0;
      }
      if (left === null) {
        return 1;
      }
      if (right === null) {
        return -1;
      }
      return left - right;
    })
    .map(([func_id, subFuncIds]) => ({
      func_id,
      sub_func_ids: stableUniqueNumbers([...subFuncIds])
    }));

  return {
    items,
    unknownTags,
    manualReviewReason: unknownTags.length > 0 ? `UNMAPPED_EXPERTISE_TAGS:${unknownTags.join(',')}` : null
  };
}

export function assertExpertiseMappingConfig(): void {
  void VALIDATED_EXPERTISE_TAG_MAP;
}
