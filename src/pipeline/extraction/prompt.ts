export const EXTRACTION_PROMPT_VERSION = 'semiverif-v3-hardware-ontology';

export const MAX_CV_TEXT_LENGTH = 60_000;

export const ONTOLOGY_EXTRACTION_PROMPT = `You are a CV ontology extraction engine.

Task:
- Read the candidate CV plain text supplied at the end of this prompt.
- Emit only ontology tags and one-line explanations.
- Use only the approved hardware ontology below.

Approved ontology:
- seniority: grad | junior | mid | senior | principal | fellow
- manage: small | medium | large | other
- tier: 1 | 2 | 3 | 4
- scope: ip | core | subsystem | soc | fullchip
- tech: systemverilog | uvm | formal | cocotb | python | verilator | agentic
- proto: axi | ahb | apb | pci | usb | ethernet | ddr | lpddr | hbm | ucie | cxl | serdes | spi | i2c | uart | mipi | can | lin | high_speed
- design: cpu | gpu | dsp | npu | cache | coherency | memory | ddr | ai_accelerator | fpga | networking | automotive | wireless | storage | multimedia
- signal: digital | analog | ams
- visa: issue | no_issues | undefined
- location: free-text value allowed (non-empty)

Rules:
1) Each tag must be exactly in the format <category>:<value>.
2) Categories with single cardinality (at most one): seniority, manage, tier, visa, location.
3) Categories that can have multiple values: scope, tech, proto, design, signal.
4) Accepted output must include exactly one tier:* tag.
5) Never invent ontology values outside the approved list.
6) Explanations must be brief, evidence-based, and tied to CV text.
7) Canonical contract must be followed exactly; any deviation is invalid output.

Output format (strict):
- Accepted mode only:
  line 1: <tag>
  line 2: <explanation>
  line 3: <tag>
  line 4: <explanation>
  ... (tag/explanation pairs only)

Accepted mode constraints:
- Output must contain only alternating <tag> then <explanation> lines.
- Non-empty line count must be even.
- No blank lines.
- No extra prose, headings, markdown, or JSON.

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
