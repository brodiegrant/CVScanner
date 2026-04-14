import { readFile } from 'node:fs/promises';
import { stdin } from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseTagExplanations } from '../pipeline/extraction/parseTagExplanations.js';
import { sortExtractionTags } from '../pipeline/extractionResult.js';

export interface ExtractTagsCliOptions {
  file?: string;
  raw: boolean;
}

export interface NormalizedAcceptedOutput {
  status: 'accepted';
  tags: string[];
  explanations: Record<string, string>;
}

export interface NormalizedRejectedOutput {
  status: 'rejected';
  tags: [];
  explanations: Record<string, never>;
  rejection_reason: string;
}

export type NormalizedOutput = NormalizedAcceptedOutput | NormalizedRejectedOutput;

export function parseCliArgs(argv: string[]): ExtractTagsCliOptions {
  const file = argv.find((arg) => arg.startsWith('--file='))?.slice('--file='.length);
  const raw = argv.includes('--raw');

  if (argv.includes('--help') || argv.includes('-h')) {
    throw new Error('USAGE');
  }

  if (file !== undefined && file.trim().length === 0) {
    throw new Error('--file must not be empty');
  }

  return {
    file,
    raw
  };
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

export async function readInputText(options: ExtractTagsCliOptions): Promise<string> {
  if (options.file) {
    return readFile(options.file, 'utf8');
  }

  if (stdin.isTTY) {
    throw new Error('Provide input via --file=<path> or STDIN');
  }

  return readStdinText();
}

export async function runExtractionService(input: string): Promise<string> {
  const text = input.trim();

  if (text.length === 0) {
    throw new Error('Model error: empty input');
  }

  if (text.length < 24) {
    return 'reject\nInsufficient information to classify the posting';
  }

  const lines: string[] = [
    'tier:t2',
    'Candidate appears viable based on the extracted content.',
    text.match(/\b(remote|work from home|distributed)\b/i) ? 'scope:remote' : 'scope:onsite',
    text.match(/\b(remote|work from home|distributed)\b/i)
      ? 'Role context indicates remote/distributed work.'
      : 'Role context suggests on-site collaboration expectations.',
    text.match(/\b(typescript|ts|node)\b/i) ? 'tech:backend' : 'signal:medium',
    text.match(/\b(typescript|ts|node)\b/i)
      ? 'Experience signals align with backend TypeScript/Node responsibilities.'
      : 'No strong technical specialization signal was detected.'
  ];

  return lines.join('\n');
}

export function normalizeParsedOutput(rawModelOutput: string): NormalizedOutput {
  const parsed = parseTagExplanations(rawModelOutput);

  if (parsed.status === 'rejected') {
    return {
      status: 'rejected',
      tags: [],
      explanations: {},
      rejection_reason: parsed.rejection_reason
    };
  }

  const tags = sortExtractionTags(parsed.tag_explanations.map((entry) => entry.tag));
  const explanations = Object.fromEntries(parsed.tag_explanations.map((entry) => [entry.tag, entry.explanation]));

  return {
    status: 'accepted',
    tags,
    explanations
  };
}

function printUsage(): void {
  process.stderr.write('Usage: npm run extract-tags -- [--file=<path>] [--raw]\n');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const options = parseCliArgs(argv);

    const input = await readInputText(options);
    const rawModelOutput = await runExtractionService(input);

    if (options.raw) {
      process.stdout.write(`${JSON.stringify({ rawModelOutput })}\n`);
      return;
    }

    const normalized = normalizeParsedOutput(rawModelOutput);
    process.stdout.write(`${JSON.stringify(normalized)}\n`);
  } catch (error) {
    if (error instanceof Error && error.message === 'USAGE') {
      printUsage();
      process.exitCode = 1;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);

    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryUrl === import.meta.url) {
  void main();
}
