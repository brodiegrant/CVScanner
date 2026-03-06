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
