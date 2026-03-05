export interface Metrics {
  increment(name: string, value?: number, fields?: Record<string, unknown>): void;
  timing(name: string, ms: number, fields?: Record<string, unknown>): void;
}

export class NoopMetrics implements Metrics {
  increment() {}
  timing() {}
}
