import fs from 'node:fs';
import path from 'node:path';
import { Metrics } from './metrics.js';
import { redact } from './logger.js';

export class JsonlMetricsSink implements Metrics {
  constructor(private readonly filepath: string) {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
  }

  increment(name: string, value = 1, fields: Record<string, unknown> = {}) {
    this.write({ type: 'counter', name, value, ...fields });
  }

  timing(name: string, ms: number, fields: Record<string, unknown> = {}) {
    this.write({ type: 'timer', name, ms, ...fields });
  }

  private write(event: Record<string, unknown>) {
    fs.appendFileSync(this.filepath, `${JSON.stringify(redact({ ts: new Date().toISOString(), ...event }))}\n`);
  }
}
