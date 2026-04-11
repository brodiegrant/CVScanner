import express from 'express';
import { Server } from 'node:http';
import { SqlitePipelineStore } from '../storage/sqlite/sqlitePipelineStore.js';

type ReviewApiConfig = {
  enabled: boolean;
  host: string;
  port: number;
};

export async function startInternalReviewApi(opts: {
  pipelineStore: SqlitePipelineStore;
  config: ReviewApiConfig;
  logger?: Pick<Console, 'info' | 'warn'>;
}): Promise<Server | null> {
  if (!opts.config.enabled) {
    opts.logger?.info?.('[review-api] disabled via INTERNAL_REVIEW_API_ENABLED=false');
    return null;
  }

  const app = createInternalReviewApiApp(opts.pipelineStore);
  const server = await new Promise<Server>((resolve, reject) => {
    const next = app.listen(opts.config.port, opts.config.host, () => resolve(next));
    next.on('error', reject);
  });

  opts.logger?.info?.(`[review-api] listening on http://${opts.config.host}:${opts.config.port}`);
  return server;
}

export function createInternalReviewApiApp(pipelineStore: SqlitePipelineStore) {
  const app = express();
  app.use(express.json());

  app.get('/review/queue', (_req, res) => {
    const queue = pipelineStore
      .listManualReviewQueue()
      .filter((item) => getResolutionFromSnapshot(item.payloadSnapshot) === null)
      .map((item) => ({
        id: item.messageId,
        reason: item.reason,
        candidateHints: safeJson(item.candidateHints),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      }));

    res.json({ items: queue });
  });

  app.get('/review/item/:id', (req, res) => {
    const messageId = req.params.id;
    const records = pipelineStore.getManualReviewByMessageId(messageId);

    if (records.length === 0) {
      res.status(404).json({ error: 'review_item_not_found', messageId });
      return;
    }

    const extraction = pipelineStore.getLatestExtractionByMessageId(messageId);
    const latestRecord = records[0];
    const latestSnapshot = safeJson(latestRecord.payloadSnapshot);

    res.json({
      id: messageId,
      reasons: records.map((item) => item.reason),
      createdAt: records.map((item) => item.createdAt).sort()[0],
      updatedAt: records.map((item) => item.updatedAt).sort().reverse()[0],
      candidateHints: records.map((item) => safeJson(item.candidateHints)),
      extraction: {
        status: extraction?.status ?? null,
        parsed: safeJson(extraction?.parsedJson),
        rawModelOutput: safeJson(extraction?.rawModelOutput),
        explanations: extractExplanations(extraction?.rawModelOutput)
      },
      matchContext: {
        matching: getNestedObject(latestSnapshot, 'matching'),
        syncResult: getNestedObject(latestSnapshot, 'syncResult')
      },
      resolution: getResolutionFromSnapshot(latestRecord.payloadSnapshot)
    });
  });

  app.post('/review/item/:id/resolve', (req, res) => {
    const messageId = req.params.id;
    const decision = req.body?.decision;
    const notes = req.body?.notes;
    const updatedPayload = req.body?.updatedPayload;

    if (decision !== 'approved' && decision !== 'updated') {
      res.status(400).json({ error: 'invalid_decision', expected: ['approved', 'updated'] });
      return;
    }

    const updatedRows = pipelineStore.resolveManualReviewByMessageId(messageId, {
      decision,
      notes: typeof notes === 'string' ? notes : undefined,
      updatedPayload: isObject(updatedPayload) ? updatedPayload : null
    });

    if (updatedRows === 0) {
      res.status(404).json({ error: 'review_item_not_found', messageId });
      return;
    }

    res.json({ status: 'ok', updatedRows, messageId, decision });
  });

  return app;
}

function safeJson(value: string | null | undefined): unknown {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function extractExplanations(rawModelOutput: string | null | undefined): unknown {
  const parsed = safeJson(rawModelOutput);
  if (!isObject(parsed)) return null;
  return parsed.explanations ?? null;
}

function getNestedObject(root: unknown, key: string): unknown {
  if (!isObject(root)) return null;
  return root[key] ?? null;
}

function getResolutionFromSnapshot(snapshot: string): unknown {
  const parsed = safeJson(snapshot);
  if (!isObject(parsed)) return null;
  return parsed.resolution ?? null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
