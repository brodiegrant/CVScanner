export const ManualReviewReasonCode = {
  LowNonLocationTagCount: 'LOW_NON_LOCATION_TAG_COUNT',
  AmbiguousCandidateMatch: 'AMBIGUOUS_CANDIDATE_MATCH',
  RejectedOutput: 'REJECTED_OUTPUT'
} as const;

export type ManualReviewReasonCode = (typeof ManualReviewReasonCode)[keyof typeof ManualReviewReasonCode];

export interface ReviewPolicyInput {
  vincereTags: string[];
  hasAmbiguousCandidateMatch: boolean;
  isRejectedOutput: boolean;
  routeRejectedOutputToReview?: boolean;
}

export interface ManualReviewQueueRecord {
  reasonCode: ManualReviewReasonCode;
}

export interface ReviewPolicyDecision {
  routeToManualReview: boolean;
  reasonCode: ManualReviewReasonCode | null;
  nonLocationTagCount: number;
  manualReviewQueueRecord: ManualReviewQueueRecord | null;
}

function isLocationTag(tag: string): boolean {
  const [prefix] = tag.split(':', 1);
  return prefix.trim().toLowerCase() === 'location';
}

export function countNonLocationTags(tags: string[]): number {
  return tags.reduce((count, tag) => (isLocationTag(tag) ? count : count + 1), 0);
}

export function evaluateReviewPolicy(input: ReviewPolicyInput): ReviewPolicyDecision {
  const nonLocationTagCount = countNonLocationTags(input.vincereTags);

  let reasonCode: ManualReviewReasonCode | null = null;

  if (input.hasAmbiguousCandidateMatch) {
    reasonCode = ManualReviewReasonCode.AmbiguousCandidateMatch;
  } else if (nonLocationTagCount <= 1) {
    reasonCode = ManualReviewReasonCode.LowNonLocationTagCount;
  } else if (input.isRejectedOutput && input.routeRejectedOutputToReview === true) {
    reasonCode = ManualReviewReasonCode.RejectedOutput;
  }

  return {
    routeToManualReview: reasonCode !== null,
    reasonCode,
    nonLocationTagCount,
    manualReviewQueueRecord: reasonCode === null ? null : { reasonCode }
  };
}
