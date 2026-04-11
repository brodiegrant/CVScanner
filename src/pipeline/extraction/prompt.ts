export const EXTRACTION_PROMPT_VERSION = 'semiverif-v1';

export const MAX_CV_TEXT_LENGTH = 60_000;

export const ONTOLOGY_EXTRACTION_PROMPT = `You are a CV ontology extraction engine.

Task:
- Read the candidate CV plain text supplied at the end of this prompt.
- Emit only ontology tags and one-line explanations.
- Use only the approved ontology below.

Approved ontology:
- seniority: intern | junior | mid | senior | staff | principal | lead | manager | director | vp | cxo
- manage: ic | lead | manager | head | director
- tier: t0 | t1 | t2 | t3 | t4 | reject
- scope: local | regional | national | global | remote | hybrid | onsite
- tech: frontend | backend | fullstack | mobile | data | ml | ai | infra | devops | security | platform
- proto: idea | prototype | mvp | production | scale
- design: system | product | ux | ui | architecture | research
- signal: urgent | strong | medium | weak | high-confidence | low-confidence
- visa: none | required | sponsored | available
- location: free-text value allowed (non-empty)

Rules:
1) Each tag must be exactly in the format <category>:<value>.
2) Categories with single cardinality (at most one): seniority, manage, tier, visa, location.
3) Categories that can have multiple values: scope, tech, proto, design, signal.
4) For non-reject outputs, include exactly one tier:* tag.
5) If the CV is irrelevant, spammy, or cannot be classified safely, use reject mode.
6) Never invent ontology values outside the approved list.
7) Explanations must be brief, evidence-based, and tied to CV text.

Output format (strict):
- Accepted mode:
  line 1: <tag>
  line 2: <explanation>
  line 3: <tag>
  line 4: <explanation>
  ... (tag/explanation pairs only; even number of lines)

- Reject mode:
  line 1: reject
  line 2: <single-sentence rejection reason>

Do not output JSON. Do not output markdown. Do not output headings.

CV_TEXT_START
{{CV_TEXT}}
CV_TEXT_END`;

export function buildExtractionPrompt(cvPlainText: string): string {
  const normalized = cvPlainText.trim();

  if (normalized.length === 0) {
    throw new Error('CV plain text cannot be empty');
  }

  if (normalized.length > MAX_CV_TEXT_LENGTH) {
    throw new Error(`CV plain text exceeds maximum length of ${MAX_CV_TEXT_LENGTH} characters`);
  }

  const safeText = normalized.replace(/\u0000/g, '').replace(/CV_TEXT_END/g, 'CV_TEXT_END_ESCAPED');

  return ONTOLOGY_EXTRACTION_PROMPT.replace('{{CV_TEXT}}', safeText);
}
