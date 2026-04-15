import { ZodError } from 'zod';
import { ExtractionTagSchema, parseExtractionResult } from '../extractionResult.js';

export type ExtractionParseStatus = 'accepted' | 'rejected';

export interface TagExplanation {
  tag: string;
  explanation: string;
}

export interface AcceptedExtractionParseResult {
  status: 'accepted';
  tag_explanations: TagExplanation[];
}

export interface RejectedExtractionParseResult {
  status: 'rejected';
  tag_explanations: [];
  rejection_reason: string;
}

export type ParsedExtractionOutput = AcceptedExtractionParseResult | RejectedExtractionParseResult;

export class ExtractionParseError extends Error {
  constructor(
    public readonly code:
      | 'EMPTY_OUTPUT'
      | 'UNEVEN_LINE_COUNT'
      | 'MISSING_REJECTION_REASON'
      | 'REJECT_MODE_EXTRA_LINES'
      | 'INVALID_TAG'
      | 'INVALID_CARDINALITY'
      | 'CONTRACT_DEVIATION',
    message: string,
    public readonly line?: number
  ) {
    super(message);
    this.name = 'ExtractionParseError';
  }
}

function toContractLines(rawText: string): string[] {
  const rawLines = rawText.split(/\r?\n/);

  for (let index = 0; index < rawLines.length; index += 1) {
    if (rawLines[index].trim().length === 0) {
      throw new ExtractionParseError(
        'CONTRACT_DEVIATION',
        'Output contains blank lines; strict line-pair contract requires one value per line',
        index + 1
      );
    }
  }

  return rawLines.map((line) => line.trim());
}

function isRejectKeyword(line: string): boolean {
  return line === 'reject';
}

export function parseTagExplanations(rawText: string): ParsedExtractionOutput {
  const lines = toContractLines(rawText);

  if (lines.length === 0) {
    throw new ExtractionParseError('EMPTY_OUTPUT', 'Model output must contain at least one non-empty line');
  }

  if (lines[0].toLowerCase() === 'reject' && !isRejectKeyword(lines[0])) {
    throw new ExtractionParseError(
      'CONTRACT_DEVIATION',
      'Reject mode keyword must be exactly "reject" on line 1',
      1
    );
  }

  if (isRejectKeyword(lines[0])) {
    if (lines.length < 2) {
      throw new ExtractionParseError('MISSING_REJECTION_REASON', 'Reject mode requires a rejection reason on line 2', 2);
    }

    if (lines.length > 2) {
      throw new ExtractionParseError('REJECT_MODE_EXTRA_LINES', 'Reject mode only allows 2 non-empty lines');
    }

    return {
      status: 'rejected',
      tag_explanations: [],
      rejection_reason: lines[1]
    };
  }

  if (lines.length % 2 !== 0) {
    throw new ExtractionParseError(
      'UNEVEN_LINE_COUNT',
      'Accepted mode requires an even number of non-empty lines (tag + explanation pairs)'
    );
  }

  const tagExplanations: TagExplanation[] = [];

  for (let index = 0; index < lines.length; index += 2) {
    const tagLineNumber = index + 1;
    const explanationLineNumber = index + 2;

    const tag = lines[index];
    const explanation = lines[index + 1];

    if (explanation.length === 0) {
      throw new ExtractionParseError(
        'CONTRACT_DEVIATION',
        `Missing explanation on line ${explanationLineNumber}`,
        explanationLineNumber
      );
    }

    try {
      ExtractionTagSchema.parse(tag);
    } catch (error) {
      const message = error instanceof ZodError
        ? error.issues.map((issue) => issue.message).join('; ')
        : 'Unknown tag validation failure';

      throw new ExtractionParseError('INVALID_TAG', `Invalid tag on line ${tagLineNumber}: ${message}`, tagLineNumber);
    }

    tagExplanations.push({
      tag,
      explanation
    });
  }

  try {
    parseExtractionResult({
      tags: tagExplanations.map((entry) => entry.tag),
      explanations: Object.fromEntries(tagExplanations.map((entry) => [entry.tag, entry.explanation])),
      location: null
    });
  } catch (error) {
    const message = error instanceof ZodError
      ? error.issues.map((issue) => issue.message).join('; ')
      : 'Unknown cardinality validation failure';

    throw new ExtractionParseError('INVALID_CARDINALITY', `Invalid tag set: ${message}`);
  }

  return {
    status: 'accepted',
    tag_explanations: tagExplanations
  };
}
