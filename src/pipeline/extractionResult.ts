import { z } from 'zod';

const APPROVED_TAG_PREFIXES = [
  'seniority',
  'manage',
  'tier',
  'scope',
  'tech',
  'proto',
  'design',
  'signal',
  'visa'
] as const;

const MULTI_VALUE_TAG_PREFIXES = new Set(['scope', 'signal']);
const SINGLE_VALUE_TAG_PREFIXES = new Set(['visa']);

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
  if (!ApprovedTagPrefixSchema.safeParse(prefix).success) {
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

  for (const prefix of SINGLE_VALUE_TAG_PREFIXES) {
    const count = tagCounts.get(prefix) ?? 0;
    if (count > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most one ${prefix}:* tag is allowed`,
        path: ['tags']
      });
    }
  }

  for (const [prefix, count] of tagCounts.entries()) {
    if (count > 1 && !MULTI_VALUE_TAG_PREFIXES.has(prefix) && !SINGLE_VALUE_TAG_PREFIXES.has(prefix)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most one ${prefix}:* tag is allowed`,
        path: ['tags']
      });
    }
  }
});

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
