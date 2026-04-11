export type CandidateIdentity = {
  id: string;
  email?: string;
  phone?: string;
  mobile?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  linkedInUrl?: string;
  location?: string;
};

export type CandidateMatchInput = {
  email?: string;
  phone?: string;
  mobile?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  linkedInUrl?: string;
  location?: string;
};

export type CandidateMatch = {
  candidateId: string;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  strategy: 'exact_email' | 'phone_or_mobile' | 'name_plus_signals';
  reasons: string[];
};

const normalize = (value?: string): string | undefined => value?.trim().toLowerCase();
const digits = (value?: string): string | undefined => value ? value.replace(/\D+/g, '') : undefined;

function confidenceFromScore(score: number): CandidateMatch['confidence'] {
  if (score >= 90) return 'high';
  if (score >= 65) return 'medium';
  return 'low';
}

export function matchCandidates(input: CandidateMatchInput, existing: CandidateIdentity[]): CandidateMatch[] {
  const email = normalize(input.email);
  if (email) {
    const emailMatches = existing
      .filter((c) => normalize(c.email) === email)
      .map((c) => ({
        candidateId: c.id,
        score: 100,
        confidence: 'high' as const,
        strategy: 'exact_email' as const,
        reasons: ['Exact email match']
      }));

    if (emailMatches.length > 0) return emailMatches;
  }

  const phoneCandidates = new Set([digits(input.phone), digits(input.mobile)].filter(Boolean));
  if (phoneCandidates.size > 0) {
    const phoneMatches = existing
      .filter((c) => {
        const existingPhones = [digits(c.phone), digits(c.mobile)].filter(Boolean);
        return existingPhones.some((p) => phoneCandidates.has(p));
      })
      .map((c) => ({
        candidateId: c.id,
        score: 90,
        confidence: 'high' as const,
        strategy: 'phone_or_mobile' as const,
        reasons: ['Phone/mobile exact digits match']
      }));

    if (phoneMatches.length > 0) return phoneMatches;
  }

  const fullName = `${normalize(input.firstName) ?? ''} ${normalize(input.lastName) ?? ''}`.trim();
  if (!fullName) return [];

  const scored = existing
    .map((c): CandidateMatch | null => {
      const candidateName = `${normalize(c.firstName) ?? ''} ${normalize(c.lastName) ?? ''}`.trim();
      if (!candidateName || candidateName !== fullName) return null;

      let score = 60;
      const reasons = ['Exact first+last name match'];

      if (normalize(input.company) && normalize(c.company) === normalize(input.company)) {
        score += 15;
        reasons.push('Company matches');
      }
      if (normalize(input.linkedInUrl) && normalize(c.linkedInUrl) === normalize(input.linkedInUrl)) {
        score += 20;
        reasons.push('LinkedIn URL matches');
      }
      if (normalize(input.location) && normalize(c.location) === normalize(input.location)) {
        score += 10;
        reasons.push('Location matches');
      }

      return {
        candidateId: c.id,
        score,
        confidence: confidenceFromScore(score),
        strategy: 'name_plus_signals',
        reasons
      };
    })
    .filter((m): m is CandidateMatch => m !== null)
    .sort((a, b) => b.score - a.score);

  return scored;
}
