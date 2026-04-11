export type VincereClientConfig = {
  apiBaseUrl: string;
  apiKey: string;
  idToken: string;
  defaultHeaders?: Record<string, string>;
};

export class VincereClient {
  constructor(private readonly config: VincereClientConfig) {}

  withIdToken(idToken: string): VincereClient {
    return new VincereClient({ ...this.config, idToken });
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.config.idToken}`);
    headers.set('x-api-key', this.config.apiKey);
    headers.set('accept', 'application/json');

    for (const [k, v] of Object.entries(this.config.defaultHeaders ?? {})) {
      headers.set(k, v);
    }

    const bodyIsJsonObject = typeof init.body === 'object' && init.body !== null && !(init.body instanceof ArrayBuffer) && !(init.body instanceof Blob) && !(init.body instanceof URLSearchParams) && !(init.body instanceof FormData) && !(init.body instanceof ReadableStream);
    if (bodyIsJsonObject) {
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(init.body);
    }

    const response = await fetch(new URL(path, this.config.apiBaseUrl), {
      ...init,
      headers
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Vincere API request failed (${response.status}) ${init.method ?? 'GET'} ${path}: ${text}`);
    }

    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: body as BodyInit | null | undefined });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body: body as BodyInit | null | undefined });
  }
}
