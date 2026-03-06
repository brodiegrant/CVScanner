import { computeSha256, type CleaningTransformationStep, type CleaningValueProvenance } from '../provenance.js';
import { applyNormalizersWithProvenance, normalizeWhitespace } from './normalizers.js';
import { computeSignals, detectPii } from './signals.js';
import type { CleaningInputDto, CleaningOutputDto } from './types.js';

function fullSpan(text: string) {
  return [{ start: 0, end: Math.max(0, text.length) }];
}

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
  const { text: clean_text, removedChars, steps } = applyNormalizersWithProvenance(bodyText);
  const pii = detectPii(clean_text);
  const signals = computeSignals({ rawText, cleanText: clean_text, bodyText, removedChars });

  const transformation_audit: CleaningTransformationStep[] = steps.map((step, index) => ({
    stepId: `cleaning-step-${index + 1}`,
    stepName: step.stepName,
    reason: step.reason,
    inputSha256: computeSha256(step.before),
    outputSha256: computeSha256(step.after),
    deterministic: step.deterministic,
    removedChars: step.removedChars,
    changed: step.before !== step.after
  }));

  const sourceArtifactId = input.provenance.preExtractionArtifacts[0]?.artifactId ?? 'message-body';
  const sourceEvidence = rawText;
  const sourceSpans = fullSpan(rawText);

  const value_provenance: CleaningValueProvenance[] = [];

  const pushValueProvenance = (fieldPath: string, cleanedValue: string | number | boolean | null, transformationType: 'copied' | 'normalized' | 'derived' | 'inferred', rationale: string) => {
    value_provenance.push({
      fieldPath,
      cleanedValue,
      transformationType,
      sourceArtifactId,
      sourceSpans,
      evidenceText: sourceEvidence,
      deterministic: true,
      inferred: transformationType === 'inferred',
      rationale
    });
  };

  pushValueProvenance('raw_text', rawText, 'copied', 'Original raw text retained for comparison.');
  pushValueProvenance('body_text', bodyText, 'normalized', 'Body text normalized from raw source text.');
  pushValueProvenance('clean_text', clean_text, 'normalized', 'Clean text generated through deterministic normalizers.');

  pushValueProvenance('pii.contains_email', pii.contains_email, 'derived', 'Derived via regex matching on cleaned text.');
  pushValueProvenance('pii.contains_phone', pii.contains_phone, 'derived', 'Derived via regex matching on cleaned text.');
  pushValueProvenance('pii.contains_ssn', pii.contains_ssn, 'derived', 'Derived via regex matching on cleaned text.');
  pushValueProvenance('pii.email_count', pii.email_count, 'derived', 'Derived via deterministic regex counting.');
  pushValueProvenance('pii.phone_count', pii.phone_count, 'derived', 'Derived via deterministic regex counting.');
  pushValueProvenance('pii.ssn_count', pii.ssn_count, 'derived', 'Derived via deterministic regex counting.');

  pushValueProvenance('signals.confidence', signals.confidence, 'derived', 'Derived from deterministic signal formulas.');
  pushValueProvenance('signals.quality', signals.quality, 'derived', 'Derived from deterministic signal formulas.');
  pushValueProvenance('signals.raw_length', signals.raw_length, 'derived', 'Derived from raw_text length.');
  pushValueProvenance('signals.clean_length', signals.clean_length, 'derived', 'Derived from clean_text length.');
  pushValueProvenance('signals.body_length', signals.body_length, 'derived', 'Derived from body_text length.');
  pushValueProvenance('signals.compression_ratio', signals.compression_ratio, 'derived', 'Derived from deterministic ratio computation.');
  pushValueProvenance('signals.boilerplate_ratio', signals.boilerplate_ratio, 'derived', 'Derived from deterministic ratio computation.');

  return {
    raw_text: rawText,
    clean_text,
    body_text: bodyText,
    signals,
    pii,
    transformation_audit,
    value_provenance,
    provenance: input.provenance,
    errors
  };
}
