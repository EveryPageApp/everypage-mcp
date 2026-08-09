/**
 * Test harness: a scripted fetch, and an in-process MCP client wired to a
 * real server. No test in this suite touches the network.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Config } from "../src/config.js";
import { buildServer } from "../src/server.js";

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export interface StubResponse {
  status?: number;
  /** Object bodies are JSON-encoded; strings are sent verbatim. */
  body?: unknown;
  headers?: Record<string, string>;
}

export type Route = (req: RecordedRequest) => StubResponse | undefined;

export interface FetchStub {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  requests: RecordedRequest[];
  /** Requests to hosts other than the configured base URL. */
  foreign: RecordedRequest[];
}

const BASE = "https://everypage.test";

/**
 * Builds a fetch that answers from `routes`, in order, and records every call.
 * An unmatched request fails loudly rather than silently 404ing - a test that
 * hits an endpoint nobody scripted is a test with a bug.
 */
export function stubFetch(routes: Route[]): FetchStub {
  const requests: RecordedRequest[] = [];
  const foreign: RecordedRequest[] = [];

  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const parsed = new URL(url);
    let body: unknown = init.body;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    const record: RecordedRequest = {
      method: init.method ?? "GET",
      url,
      path: parsed.pathname,
      query: parsed.searchParams,
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      body,
    };

    if (parsed.origin === BASE) requests.push(record);
    else foreign.push(record);

    for (const route of routes) {
      const stub = route(record);
      if (stub) {
        const status = stub.status ?? 200;
        const payload =
          typeof stub.body === "string" || stub.body === undefined ? (stub.body ?? "") : JSON.stringify(stub.body);
        // 204/205/304 must have a null body or the Response constructor throws.
        const NO_BODY = new Set([204, 205, 304]);
        return new Response(NO_BODY.has(status) ? null : payload, {
          status,
          headers: { "content-type": "application/json", ...(stub.headers ?? {}) },
        });
      }
    }

    throw new Error(`No stub matched ${record.method} ${parsed.pathname}${parsed.search}`);
  };

  return { fetch, requests, foreign };
}

/** Matches a method + path (exact), optionally only the Nth time it is seen. */
export function route(method: string, path: string, response: StubResponse): Route {
  return (req) => (req.method === method && req.path === path ? response : undefined);
}

/** Like `route`, but answers each call from a queue, in order. */
export function routeSequence(method: string, path: string, responses: StubResponse[]): Route {
  const queue = [...responses];
  return (req) => {
    if (req.method !== method || req.path !== path) return undefined;
    return queue.length > 1 ? queue.shift() : queue[0];
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { apiKey: "ep_live_test", baseUrl: BASE, readOnly: false, ...overrides };
}

export interface Harness {
  client: Client;
  stub: FetchStub;
  call: (tool: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  text: (result: CallToolResult) => string;
  close: () => Promise<void>;
}

/** Connects a client to a server over an in-memory pair. */
export async function harness(routes: Route[], config: Partial<Config> = {}): Promise<Harness> {
  const stub = stubFetch(routes);
  const server = buildServer(testConfig(config), {
    fetchFn: stub.fetch,
    // Backoff must not actually sleep, or the 429 test takes seconds.
    sleepFn: async () => {},
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  // Load the tool list up front, exactly as a real client does. This is not
  // incidental: the SDK client only caches output-schema validators from
  // `listTools`, so without this call every tool result goes UNVALIDATED and
  // schema violations sail through the suite. That is how an error result
  // carrying structuredContent - which the client rejects outright, turning a
  // readable failure into an opaque -32602 - reached a live run undetected.
  await client.listTools();

  const text = (result: CallToolResult): string =>
    (result.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");

  return {
    client,
    stub,
    call: (tool, args = {}) => client.callTool({ name: tool, arguments: args }) as Promise<CallToolResult>,
    text,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export const USER_ROUTE = route("GET", "/api/v1/user", {
  body: { name: "Test", email: "test@example.com", subscription: "pro" },
});

export const FILE_UUID = "11111111-2222-3333-4444-555555555555";

export function fileRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: FILE_UUID,
    shortId: "aB3xY9kQ2mZ7",
    originalName: "proposal.pdf",
    size: 2_200_000,
    totalPages: 14,
    viewCount: 23,
    createdAt: "2026-08-01T09:00:00Z",
    allowDownload: true,
    ...overrides,
  };
}
