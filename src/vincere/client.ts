export type VincereClientConfig = {
  apiBaseUrl: string;
  apiKey: string;
  idToken: string;
  defaultHeaders?: Record<string, string>;
};

export type CandidateLookupResult = {
  id: string;
  [key: string]: unknown;
};

export type CandidateDocumentUpload = {
  filename: string;
  mimeType?: string;
  data: Buffer;
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

    const bodyIsJsonObject = typeof init.body === 'object'
      && init.body !== null
      && !(init.body instanceof ArrayBuffer)
      && !(init.body instanceof Blob)
      && !(init.body instanceof URLSearchParams)
      && !(init.body instanceof FormData)
      && !(init.body instanceof ReadableStream);
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

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('application/json')) {
      return await response.json() as T;
    }

    if (contentType.includes('text/')) {
      return await response.text() as T;
    }

    return undefined as T;
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

  async findCandidateByEmail(email: string): Promise<CandidateLookupResult | null> {
    const normalizedEmail = email.trim();
    if (!normalizedEmail) return null;

    const path = `/api/candidate/search?email=${encodeURIComponent(normalizedEmail)}`;
    const response = await this.get<unknown>(path);

    if (Array.isArray(response)) {
      const [first] = response;
      return this.asCandidateResult(first);
    }

    if (this.isRecord(response)) {
      const collection = this.pickCollection(response);
      if (collection.length > 0) {
        return this.asCandidateResult(collection[0]);
      }
      return this.asCandidateResult(response);
    }

    return null;
  }

  async updateFunctionalExpertiseLinks(candidateId: string, expertiseIds: string[]): Promise<void> {
    const deduped = [...new Set(expertiseIds.map((id) => id.trim()).filter(Boolean))];
    if (deduped.length === 0) return;

    await this.patch<void>(`/api/candidate/${encodeURIComponent(candidateId)}/functional-expertise`, {
      candidateId,
      functionalExpertiseIds: deduped
    });
  }

  async updateSubFunctionalExpertiseLinks(candidateId: string, expertiseIds: string[]): Promise<void> {
    const deduped = [...new Set(expertiseIds.map((id) => id.trim()).filter(Boolean))];
    if (deduped.length === 0) return;

    await this.patch<void>(`/api/candidate/${encodeURIComponent(candidateId)}/sub-functional-expertise`, {
      candidateId,
      subFunctionalExpertiseIds: deduped
    });
  }

  async uploadCandidateDocument(candidateId: string, input: CandidateDocumentUpload): Promise<void> {
    const form = new FormData();
    const mimeType = input.mimeType?.trim() || 'application/octet-stream';
    form.append('file', new Blob([new Uint8Array(input.data)], { type: mimeType }), input.filename);

    await this.post<void>(`/api/candidate/${encodeURIComponent(candidateId)}/document`, form);
  }

  private pickCollection(value: Record<string, unknown>): unknown[] {
    const keys = ['results', 'items', 'data', 'candidates'];
    for (const key of keys) {
      const candidate = value[key];
      if (Array.isArray(candidate)) {
        return candidate;
      }
    }
    return [];
  }

  private asCandidateResult(value: unknown): CandidateLookupResult | null {
    if (!this.isRecord(value)) return null;
    const id = value.id;
    if (typeof id !== 'string' || !id.trim()) return null;
    return { ...value, id };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
