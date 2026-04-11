import type { CleaningOutputDto } from '../cleaning/types.js';
import { sortExtractionTags } from '../extractionResult.js';

export type ExtractionCandidate = {
  status: 'parsed' | 'rejected';
  rawModelOutput: Record<string, unknown>;
  parsedTagExplanationJson: string;
  rejectionReason: string | null;
  modelName: string;
  promptVersion: string;
  tags: string[];
};

export function buildExtractionCandidate(cleaned: Pick<CleaningOutputDto, 'signals' | 'pii'>): ExtractionCandidate {
  const derivedTags: string[] = [];

  if (cleaned.signals.confidence >= 0.8) derivedTags.push('signal:strong');
  if (cleaned.signals.confidence <= 0.4) derivedTags.push('signal:weak');
  if (cleaned.signals.raw_length >= 1500) derivedTags.push('scope:global');
  if (cleaned.pii.contains_email) derivedTags.push('signal:contact_info');

  const tags = sortExtractionTags(derivedTags);
  const rawModelOutput = {
    tags,
    explanations: tags.map((tag) => ({ tag, explanation: `Derived from deterministic cleaning signals for ${tag}.` }))
  };

  return {
    status: tags.length > 0 ? 'parsed' : 'rejected',
    rawModelOutput,
    parsedTagExplanationJson: JSON.stringify(rawModelOutput),
    rejectionReason: tags.length > 0 ? null : 'No extraction tags produced from cleaning signals',
    modelName: 'deterministic-cleaning-derived',
    promptVersion: 'v1',
    tags
  };
}
