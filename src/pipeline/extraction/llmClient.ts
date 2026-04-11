import { createLogger } from '../../observability/logger.js';

export type LlmClientConfig = {
  apiKey: string;
  model: string;
  timeoutMs: number;
  retries: number;
};

export type LlmRequest = {
  resumeText: string;
  messageId: string;
  contentHash?: string;
};

export class LlmClientError extends Error {
  readonly status?: number;
  readonly attempt: number;

  constructor(message: string, attempt: number, status?: number) {
    super(message);
    this.name = 'LlmClientError';
    this.status = status;
    this.attempt = attempt;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

const logger = createLogger('info');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof LlmClientError && typeof error.status === 'number') {
    return RETRYABLE_STATUS.has(error.status);
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }

  return error instanceof TypeError;
}

function parseRawText(responseJson: unknown): string {
  if (!responseJson || typeof responseJson !== 'object') {
    throw new Error('LLM response body is not an object');
  }

  const chatCompletions = (responseJson as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const content = chatCompletions?.[0]?.message?.content;
  if (typeof content === 'string') return content;

  throw new Error('LLM response did not include text content');
}

export async function requestLlmRawText(config: LlmClientConfig, req: LlmRequest): Promise<string> {
  const maxRetries = Math.max(0, Math.min(config.retries, DEFAULT_MAX_RETRIES));

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    logger.info('llm.request.start', {
      messageId: req.messageId,
      contentHash: req.contentHash,
      resumeTextLength: req.resumeText.length,
      model: config.model,
      timeoutMs: config.timeoutMs,
      attempt
    });

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: req.resumeText }]
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const responseText = await response.text();
        logger.warn('llm.request.http_error', {
          messageId: req.messageId,
          contentHash: req.contentHash,
          resumeTextLength: req.resumeText.length,
          status: response.status,
          attempt,
          responseLength: responseText.length
        });
        throw new LlmClientError('LLM HTTP error', attempt, response.status);
      }

      const payload = (await response.json()) as unknown;
      const rawText = parseRawText(payload);
      logger.info('llm.request.success', {
        messageId: req.messageId,
        contentHash: req.contentHash,
        resumeTextLength: req.resumeText.length,
        responseTextLength: rawText.length,
        attempt
      });
      return rawText;
    } catch (error) {
      const retryable = isRetryableError(error);
      const exhausted = attempt > maxRetries;

      logger[retryable && !exhausted ? 'warn' : 'error']('llm.request.failure', {
        messageId: req.messageId,
        contentHash: req.contentHash,
        resumeTextLength: req.resumeText.length,
        attempt,
        retryable,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error)
      });

      if (!retryable || exhausted) {
        throw error;
      }

      await sleep(RETRY_DELAY_MS * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('LLM request failed unexpectedly');
}
