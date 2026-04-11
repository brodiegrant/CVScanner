import { z } from 'zod';
import {
  isAllowedTagValue,
  MULTI_VALUE_CATEGORIES,
  SINGLE_VALUE_CATEGORIES,
  TAG_ALLOWLIST,
  type TagCategory
} from './ontology.js';

const APPROVED_TAG_PREFIXES = Object.keys(TAG_ALLOWLIST) as [TagCategory, ...TagCategory[]];

export const ApprovedTagPrefixSchema = z.enum(APPROVED_TAG_PREFIXES);

export const ExtractionTagSchema = z.string().trim().min(1).superRefine((value, ctx) => {
  const parts = value.split(':');

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Expected tag format <category>:<value>'
    });
    return;
  }

  const [prefix, suffix] = parts;
  const prefixResult = ApprovedTagPrefixSchema.safeParse(prefix);
  if (!prefixResult.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Tag category \"${prefix}\" is not in the approved vocabulary`
    });
    return;
  }

  if (suffix.trim().length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Tag values must be non-empty'
    });
    return;
  }

  const category = prefixResult.data;
  if (!isAllowedTagValue(category, suffix)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Tag value \"${suffix}\" is not allowed for ${category}`
    });
  }
});

export const ExtractionLocationSchema = z.object({
  city: z.string().trim().min(1).optional(),
  country: z.string().trim().min(1).optional(),
  country_code: z.string().trim().min(1).optional(),
  state: z.string().trim().min(1).optional(),
  address: z.string().trim().min(1).optional(),
  address_line1: z.string().trim().min(1).optional(),
  address_line2: z.string().trim().min(1).optional(),
  district: z.string().trim().min(1).optional(),
  post_code: z.string().trim().min(1).optional(),
  latitude: z.number().finite().optional(),
  longitude: z.number().finite().optional(),
  location_name: z.string().trim().min(1).optional(),
  nearest_train_station: z.string().trim().min(1).optional()
}).strict();

const normalizeTag = (tag: string) => tag.trim();

const compareTags = (left: string, right: string) => {
  const [leftPrefix, leftValue] = left.split(':', 2) as [string, string];
  const [rightPrefix, rightValue] = right.split(':', 2) as [string, string];

  if (leftPrefix === rightPrefix) {
    return leftValue.localeCompare(rightValue);
  }

  return leftPrefix.localeCompare(rightPrefix);
};

function normalizeAndSortTags(tags: string[]) {
  return [...new Set(tags.map(normalizeTag))].sort(compareTags);
}

export const ExtractionMetadataSchema = z.object({
  promptVersion: z.string().trim().min(1).optional(),
  modelName: z.string().trim().min(1).optional(),
  warnings: z.array(z.string().trim().min(1)).optional()
}).strict();

export const ExtractionResultSchema = z.object({
  tags: z.array(ExtractionTagSchema).transform(normalizeAndSortTags),
  explanations: z.record(z.string().trim().min(1), z.string().trim().min(1)).default({}),
  location: ExtractionLocationSchema.nullable(),
  promptVersion: z.string().trim().min(1).optional(),
  modelName: z.string().trim().min(1).optional(),
  warnings: z.array(z.string().trim().min(1)).optional()
}).superRefine((value, ctx) => {
  const tagCounts = new Map<string, number>();

  for (const tag of value.tags) {
    const [prefix] = tag.split(':', 2);
    tagCounts.set(prefix, (tagCounts.get(prefix) ?? 0) + 1);
  }

  for (const [prefix, count] of tagCounts.entries()) {
    if (count > 1 && SINGLE_VALUE_CATEGORIES.has(prefix as TagCategory)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most one ${prefix}:* tag is allowed`,
        path: ['tags']
      });
    }

    if (count > 1 && !MULTI_VALUE_CATEGORIES.has(prefix as TagCategory) && !SINGLE_VALUE_CATEGORIES.has(prefix as TagCategory)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most one ${prefix}:* tag is allowed`,
        path: ['tags']
      });
    }
  }

  const tierCount = tagCounts.get('tier') ?? 0;
  const isRejectOutput = value.tags.includes('tier:reject');
  if (!isRejectOutput && tierCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Exactly one tier:* tag is required for non-reject output',
      path: ['tags']
    });
  }

  for (const tag of value.tags) {
    const explanation = value.explanations[tag];
    if (!explanation || explanation.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Missing explanation for emitted tag \"${tag}\"`,
        path: ['explanations', tag]
      });
    }
  }
});

const TagExplanationLineSchema = z.object({
  tag: ExtractionTagSchema,
  explanation: z.string().trim().min(1)
});

export function parseTagExplanationLines(lines: string[]): { tags: string[]; explanations: Record<string, string> } {
  const trimmed = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (trimmed.length % 2 !== 0) {
    throw new Error('Expected tag/explanation line pairs');
  }

  const tags: string[] = [];
  const explanations: Record<string, string> = {};

  for (let i = 0; i < trimmed.length; i += 2) {
    const pair = TagExplanationLineSchema.parse({
      tag: trimmed[i],
      explanation: trimmed[i + 1]
    });

    tags.push(pair.tag);
    explanations[pair.tag] = pair.explanation;
  }

  return { tags, explanations };
}

export type ApprovedTagPrefix = z.infer<typeof ApprovedTagPrefixSchema>;
export type ExtractionLocation = z.infer<typeof ExtractionLocationSchema>;
export type ExtractionMetadata = z.infer<typeof ExtractionMetadataSchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

export function parseExtractionResult(input: unknown): ExtractionResult {
  return ExtractionResultSchema.parse(input);
}

export function sortExtractionTags(tags: string[]): string[] {
  return normalizeAndSortTags(ExtractionTagSchema.array().parse(tags));
}
