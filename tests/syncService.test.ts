import { describe, expect, it, vi } from 'vitest';
import { syncCandidateToVincere } from '../src/vincere/syncService.js';

describe('syncCandidateToVincere', () => {
  it('quarantines to manual review when expertise tags are unmapped', async () => {
    const enqueue = vi.fn(async () => undefined);
    const vincereClient = {
      findCandidateByEmail: vi.fn(async () => null),
      post: vi.fn(async () => ({ id: 'cand-1' })),
      patch: vi.fn(async () => undefined),
      updateFunctionalExpertiseLinks: vi.fn(async () => undefined),
      updateExpertiseLinks: vi.fn(async () => undefined),
      uploadCandidateDocument: vi.fn(async () => undefined)
    } as any;

    const result = await syncCandidateToVincere({
      sourceId: 'm-1',
      payload: {
        email: 'candidate@example.com',
        firstName: 'A',
        lastName: 'B',
        expertiseTags: ['tech:python', 'scope:global']
      },
      existingCandidates: [],
      vincereClient,
      reviewQueue: { enqueue }
    });

    expect(result).toEqual({ disposition: 'manual_review', reason: 'UNMAPPED_EXPERTISE_TAGS:scope:global' });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(vincereClient.findCandidateByEmail).not.toHaveBeenCalled();
    expect(vincereClient.post).not.toHaveBeenCalled();
    expect(vincereClient.patch).not.toHaveBeenCalled();
  });
});
