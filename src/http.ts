/**
 * Thin fetch layer over the EveryPage API.
 *
 * Conventions ported from the `@everypage/node` SDK (github-org/everypage-node
 * src/http.ts) - they encode wire quirks that are expensive to rediscover:
 *
 *  - Error bodies are PLAIN TEXT, even on endpoints that answer JSON on
 *    success. Read them with `res.text()`; never JSON.parse them.
 *  - A 429 carries no `Retry-After` and no rate-limit headers, so backoff is
 *    blind.
 *  - There are no idempotency keys, so POST/PUT never retry by default.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  token: string;
  baseUrl: string;
  fetchFn?: FetchLike;
  maxRetries?: number;
  /** Injectable sleep so tests don't actually wait out the backoff. */
  sleepFn?: (ms: number) => Promise<void>;
}

export type QueryValue = string | number | boolean | undefined;

export interface RequestParams {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  /** Query parameters; `undefined` values are omitted. */
  query?: Record<string, QueryValue>;
  /** JSON-encoded request body. Mutually exclusive with `formBody`. */
  jsonBody?: unknown;
  /** Multipart request body. Mutually exclusive with `jsonBody`. */
  formBody?: FormData;
  /**
   * Opt a POST/PUT into 429 retries. Off by default: the API has no
   * idempotency keys, so a retried write may be applied twice. GET and DELETE
   * retry automatically (DELETE is idempotent by shape).
   */
  retryable?: boolean;
}

/** A non-2xx response from the EveryPage API. `body` is the raw text. */
export class EveryPageApiError extends Error {
  override readonly name = "EveryPageApiError";
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(body || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

const RETRY_BY_DEFAULT = new Set(["GET", "DELETE"]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Blind exponential backoff with jitter: 125-250ms, 250-500ms, 500-1000ms,
 * ... capped at 2-4s. Blind because a 429 tells us nothing about when to
 * come back.
 */
function backoffMs(attempt: number): number {
  const cap = Math.min(4000, 250 * 2 ** attempt);
  return cap / 2 + Math.random() * (cap / 2);
}

export class HttpClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #maxRetries: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: HttpClientOptions) {
    const fetchFn = options.fetchFn;
    if (fetchFn === undefined && typeof globalThis.fetch !== "function") {
      throw new TypeError("No global fetch found - Node 20 or newer is required.");
    }
    this.#token = options.token;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = fetchFn ?? ((url, init) => globalThis.fetch(url, init));
    this.#maxRetries = options.maxRetries ?? 2;
    this.#sleep = options.sleepFn ?? defaultSleep;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async request(params: RequestParams): Promise<Response> {
    const url = new URL(this.#baseUrl + params.path);
    for (const [key, value] of Object.entries(params.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${this.#token}` };
    let body: string | FormData | undefined;
    if (params.formBody !== undefined) {
      body = params.formBody; // fetch sets the multipart boundary itself
    } else if (params.jsonBody !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(params.jsonBody);
    }

    const retryOn429 = params.retryable ?? RETRY_BY_DEFAULT.has(params.method);

    for (let attempt = 0; ; attempt++) {
      const res = await this.#fetch(url.toString(), { method: params.method, headers, body });

      if (res.status === 429 && retryOn429 && attempt < this.#maxRetries) {
        await this.#sleep(backoffMs(attempt));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new EveryPageApiError(res.status, text.trim());
      }

      return res;
    }
  }

  async json<T>(params: RequestParams): Promise<T> {
    const res = await this.request(params);
    return (await res.json()) as T;
  }

  /**
   * For endpoints whose success body is empty or an unspecified
   * acknowledgement (the settings PUT, DELETE). Drains the body so the
   * connection can be reused.
   */
  async empty(params: RequestParams): Promise<void> {
    const res = await this.request(params);
    await res.arrayBuffer().catch(() => undefined);
  }

  /**
   * Like `json`, but tolerates an empty or non-JSON success body by
   * returning `undefined` - several write endpoints answer 200 with nothing
   * useful, and their callers only want the body when it happens to be there.
   */
  async jsonOrUndefined<T>(params: RequestParams): Promise<T | undefined> {
    const res = await this.request(params);
    const text = await res.text().catch(() => "");
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }
}
