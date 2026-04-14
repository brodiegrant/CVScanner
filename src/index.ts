export { connectAccount } from './gmail/oauth/oauthClient.js';
export { ingestOnce } from './gmail/ingest/ingestService.js';
export type { RunSummary, IngestForLlm } from './gmail/ingest/ingestService.js';

export {
  VINCERE_AUTHORIZE_URL,
  VINCERE_TOKEN_URL,
  buildVincereAuthorizeUrl,
  acquireVincereToken,
  refreshVincereToken,
  isTokenExpiringSoon
} from './vincere/auth.js';
export type { VincereOAuthConfig, VincereTokenResponse, VincereTokenSet } from './vincere/auth.js';

export { VincereClient } from './vincere/client.js';
export type { VincereClientConfig } from './vincere/client.js';

export { matchCandidates } from './vincere/matching.js';
export type { CandidateIdentity, CandidateMatchInput, CandidateMatch } from './vincere/matching.js';

export { syncCandidateToVincere } from './vincere/syncService.js';
export type {
  VincereSyncCandidatePayload,
  ManualReviewItem,
  ManualReviewQueue,
  SyncResult
} from './vincere/syncService.js';

export { createInternalReviewApiApp, startInternalReviewApi } from './review/internalReviewApi.js';

export { mapTagsToExpertiseLinks, assertExpertiseMappingConfig, EXPERTISE_TAG_MAP } from './vincere/expertiseMapping.js';
export type { ExpertiseLinkPayloadItem, ExpertiseMappingResult } from './vincere/expertiseMapping.js';
