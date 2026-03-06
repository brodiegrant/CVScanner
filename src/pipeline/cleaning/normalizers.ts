const BOILERPLATE_PATTERNS: RegExp[] = [
  /^sent from my (iphone|android).*/gim,
  /^best regards,?.*/gim,
  /^kind regards,?.*/gim,
  /^unsubscribe\b.*/gim,
  /^this email and any attachments are confidential.*/gim
];

export function normalizeUnicode(text: string): string {
  return text.normalize('NFKC');
}

export type NormalizerStepResult = {
  stepName: 'normalize_unicode' | 'normalize_whitespace' | 'strip_boilerplate';
  reason: string;
  before: string;
  after: string;
  removedChars: number;
  deterministic: true;
};

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

export function stripBoilerplate(text: string): { text: string; removedChars: number } {
  let cleaned = text;
  let removedChars = 0;

  for (const pattern of BOILERPLATE_PATTERNS) {
    cleaned = cleaned.replace(pattern, (match) => {
      removedChars += match.length;
      return '';
    });
  }

  return { text: cleaned.trim(), removedChars };
}

export function applyNormalizers(text: string): { text: string; removedChars: number } {
  const unicode = normalizeUnicode(text);
  const whitespace = normalizeWhitespace(unicode);
  return stripBoilerplate(whitespace);
}

export function applyNormalizersWithProvenance(text: string): {
  text: string;
  removedChars: number;
  steps: NormalizerStepResult[];
} {
  const unicode = normalizeUnicode(text);
  const whitespace = normalizeWhitespace(unicode);
  const stripped = stripBoilerplate(whitespace);

  return {
    text: stripped.text,
    removedChars: stripped.removedChars,
    steps: [
      {
        stepName: 'normalize_unicode',
        reason: 'unicode_nfkc_normalization',
        before: text,
        after: unicode,
        removedChars: 0,
        deterministic: true
      },
      {
        stepName: 'normalize_whitespace',
        reason: 'whitespace_normalization',
        before: unicode,
        after: whitespace,
        removedChars: Math.max(0, unicode.length - whitespace.length),
        deterministic: true
      },
      {
        stepName: 'strip_boilerplate',
        reason: 'boilerplate_stripped',
        before: whitespace,
        after: stripped.text,
        removedChars: stripped.removedChars,
        deterministic: true
      }
    ]
  };
}
