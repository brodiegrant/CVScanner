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
  'tech:frontend': { func_id: 100, sub_func_ids: [1001] },
  'tech:backend': { func_id: 100, sub_func_ids: [1002] },
  'tech:fullstack': { func_id: 100, sub_func_ids: [1001, 1002] },
  'tech:mobile': { func_id: 100, sub_func_ids: [1003] },
  'tech:data': { func_id: 101, sub_func_ids: [1011] },
  'tech:ml': { func_id: 101, sub_func_ids: [1012] },
  'tech:ai': { func_id: 101, sub_func_ids: [1013] },
  'tech:infra': { func_id: 102, sub_func_ids: [1021] },
  'tech:devops': { func_id: 102, sub_func_ids: [1022] },
  'tech:security': { func_id: 102, sub_func_ids: [1023] },
  'tech:platform': { func_id: 102, sub_func_ids: [1024] },
  'design:system': { func_id: 103, sub_func_ids: [1031] },
  'design:product': { func_id: 103, sub_func_ids: [1032] },
  'design:ux': { func_id: 103, sub_func_ids: [1033] },
  'design:ui': { func_id: 103, sub_func_ids: [1034] },
  'design:architecture': { func_id: 103, sub_func_ids: [1035] },
  'design:research': { func_id: 103, sub_func_ids: [1036] }
} as const;

const VALIDATED_EXPERTISE_TAG_MAP = validateExpertiseTagMap(EXPERTISE_TAG_MAP);

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
