import { describe, expect, it } from 'vitest';
import { countNonLocationTags, evaluateReviewPolicy, ManualReviewReasonCode } from './reviewPolicy.js';

describe('review policy', () => {
  it('counts only non-location tags proposed for Vincere', () => {
    expect(countNonLocationTags([
      'location:london',
      'tech:typescript',
      'location:uk',
      'seniority:mid'
    ])).toBe(2);
  });

  it('routes to manual review when non-location tag count is less than or equal to one', () => {
    const decision = evaluateReviewPolicy({
      vincereTags: ['location:london'],
      hasAmbiguousCandidateMatch: false,
      isRejectedOutput: false
    });

    expect(decision.routeToManualReview).toBe(true);
    expect(decision.reasonCode).toBe(ManualReviewReasonCode.LowNonLocationTagCount);
    expect(decision.manualReviewQueueRecord).toEqual({
      reasonCode: ManualReviewReasonCode.LowNonLocationTagCount
    });
  });

  it('routes to manual review when candidate matching is ambiguous', () => {
    const decision = evaluateReviewPolicy({
      vincereTags: ['tech:typescript', 'seniority:mid'],
      hasAmbiguousCandidateMatch: true,
      isRejectedOutput: false
    });

    expect(decision.routeToManualReview).toBe(true);
    expect(decision.reasonCode).toBe(ManualReviewReasonCode.AmbiguousCandidateMatch);
  });

  it('optionally routes rejected outputs to manual review', () => {
    const decision = evaluateReviewPolicy({
      vincereTags: ['tech:typescript', 'seniority:mid'],
      hasAmbiguousCandidateMatch: false,
      isRejectedOutput: true,
      routeRejectedOutputToReview: true
    });

    expect(decision.routeToManualReview).toBe(true);
    expect(decision.reasonCode).toBe(ManualReviewReasonCode.RejectedOutput);
    expect(decision.manualReviewQueueRecord).toEqual({
      reasonCode: ManualReviewReasonCode.RejectedOutput
    });
  });

  it('does not route rejected outputs when optional routing is disabled', () => {
    const decision = evaluateReviewPolicy({
      vincereTags: ['tech:typescript', 'seniority:mid'],
      hasAmbiguousCandidateMatch: false,
      isRejectedOutput: true,
      routeRejectedOutputToReview: false
    });

    expect(decision.routeToManualReview).toBe(false);
    expect(decision.reasonCode).toBeNull();
    expect(decision.manualReviewQueueRecord).toBeNull();
  });
});
