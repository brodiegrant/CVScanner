import { applyNormalizers, normalizeWhitespace } from './normalizers.js';
import { computeSignals, detectPii } from './signals.js';
import type { CleaningInputDto, CleaningOutputDto } from './types.js';

export function runCleaningPipeline(input: CleaningInputDto): CleaningOutputDto {
  const errors: CleaningOutputDto['errors'] = [];

  if (!input.raw_text.trim()) {
    errors.push({
      kind: 'BodyMissingError',
      stage: 'cleaning',
      messageId: input.message_id,
      message: 'raw_text is empty after trimming'
    });
  }

  const rawText = input.raw_text;
  const bodyText = normalizeWhitespace(input.body_text ?? rawText);
  const { text: clean_text, removedChars } = applyNormalizers(bodyText);
  const pii = detectPii(clean_text);
  const signals = computeSignals({ rawText, cleanText: clean_text, bodyText, removedChars });

  return {
    raw_text: rawText,
    clean_text,
    body_text: bodyText,
    signals,
    pii,
    provenance: input.provenance,
    errors
  };
}
