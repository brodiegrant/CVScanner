import { buildExtractionPrompt, EXTRACTION_PROMPT_VERSION } from './prompt.js';

export interface LlmClient {
  generate(prompt: string): Promise<{
    rawOutput: string;
    modelName: string;
  }>;
}

export interface ExtractionServiceResult {
  rawOutput: string;
  modelName: string;
  promptVersion: string;
  timestamp: string;
}

export async function runExtractionService(cvPlainText: string, llmClient: LlmClient): Promise<ExtractionServiceResult> {
  const prompt = buildExtractionPrompt(cvPlainText);
  const response = await llmClient.generate(prompt);

  return {
    rawOutput: response.rawOutput,
    modelName: response.modelName,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    timestamp: new Date().toISOString()
  };
}
