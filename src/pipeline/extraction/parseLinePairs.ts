import { ZodError } from 'zod';
import { ExtractionTagSchema, parseExtractionResult } from '../extractionResult.js';

export interface LinePairItem {
  tag: string;
  explanation: string;
}

export interface AcceptedLinePairs {
  status: 'accepted';
  items: LinePairItem[];
  rejectionReason?: undefined;
}

export interface RejectedLinePairs {
  status: 'rejected';
  items: [];
  rejectionReason: string;
}

export type ParsedLinePairs = AcceptedLinePairs | RejectedLinePairs;

export class ParseLinePairsError extends Error {
  constructor(
    public readonly code:
      | 'EMPTY_OUTPUT'
      | 'UNEVEN_LINE_COUNT'
      | 'MISSING_REJECTION_REASON'
      | 'REJECT_MODE_EXTRA_LINES'
      | 'INVALID_TAG'
      | 'INVALID_CARDINALITY',
    message: string,
    public readonly line?: number
  ) {
    super(message);
    this.name = 'ParseLinePairsError';
  }
}

function toNonEmptyLines(rawText: string): string[] {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isRejectKeyword(line: string): boolean {
  return line.toLowerCase() === 'reject';
}

export function parseLinePairs(rawText: string): ParsedLinePairs {
  const lines = toNonEmptyLines(rawText);

  if (lines.length === 0) {
    throw new ParseLinePairsError('EMPTY_OUTPUT', 'Model output must contain at least one non-empty line');
  }

  if (isRejectKeyword(lines[0])) {
    if (lines.length < 2) {
      throw new ParseLinePairsError('MISSING_REJECTION_REASON', 'Reject mode requires a rejection reason on line 2', 2);
    }

    if (lines.length > 2) {
      throw new ParseLinePairsError('REJECT_MODE_EXTRA_LINES', 'Reject mode only allows 2 non-empty lines');
    }

    return {
      status: 'rejected',
      items: [],
      rejectionReason: lines[1]
    };
  }

  if (lines.length % 2 !== 0) {
    throw new ParseLinePairsError(
      'UNEVEN_LINE_COUNT',
      'Accepted mode requires an even number of non-empty lines (tag + explanation pairs)'
    );
  }

  const items: LinePairItem[] = [];

  for (let index = 0; index < lines.length; index += 2) {
    const tagLineNumber = index + 1;
    const tag = lines[index];
    const explanation = lines[index + 1];

    try {
      ExtractionTagSchema.parse(tag);
    } catch (error) {
      const message = error instanceof ZodError
        ? error.issues.map((issue) => issue.message).join('; ')
        : 'Unknown tag validation failure';

      throw new ParseLinePairsError('INVALID_TAG', `Invalid tag on line ${tagLineNumber}: ${message}`, tagLineNumber);
    }

    items.push({ tag, explanation });
  }

  try {
    parseExtractionResult({
      tags: items.map((entry) => entry.tag),
      explanations: Object.fromEntries(items.map((entry) => [entry.tag, entry.explanation])),
      location: null
    });
  } catch (error) {
    const message = error instanceof ZodError
      ? error.issues.map((issue) => issue.message).join('; ')
      : 'Unknown cardinality validation failure';

    throw new ParseLinePairsError('INVALID_CARDINALITY', `Invalid tag set: ${message}`);
  }

  return {
    status: 'accepted',
    items
  };
}
