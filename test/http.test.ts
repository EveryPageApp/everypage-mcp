import { describe, expect, it } from "vitest";

import { EveryPageApiError, HttpClient } from "../src/http.js";
import { loadConfig, ConfigError } from "../src/config.js";

function client(fetchFn: (url: string, init: RequestInit) => Promise<Response>, maxRetries = 2): HttpClient {
  return new HttpClient({
    token: "ep_live_x",
    baseUrl: "https://everypage.test",
    fetchFn,
    maxRetries,
    sleepFn: async () => {},
  });
}

describe("HttpClient", () => {
  it("sends the bearer token and builds the query string", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const http = client(async (url, init) => {
      seen = { url, headers: init.headers as Record<string, string> };
      return new Response("[]", { status: 200 });
    });

    await http.json({ method: "GET", path: "/api/v1/events", query: { type: "view", since: 5, file: undefined } });

    expect(seen!.headers.Authorization).toBe("Bearer ep_live_x");
    // `undefined` query values are dropped, not sent as the string "undefined".
    expect(seen!.url).toBe("https://everypage.test/api/v1/events?type=view&since=5");
  });

  it("reads error bodies as text, never as JSON", async () => {
    // The API answers plain text on failure even where success is JSON.
    const http = client(async () => new Response("This feature requires the pro plan or higher", { status: 403 }));

    await expect(http.json({ method: "GET", path: "/api/v1/files" })).rejects.toMatchObject({
      status: 403,
      body: "This feature requires the pro plan or higher",
    });
  });

  it("survives an error body that is not valid JSON", async () => {
    const http = client(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    const err = await http.json({ method: "GET", path: "/api/v1/files" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EveryPageApiError);
    expect((err as EveryPageApiError).body).toContain("502 Bad Gateway");
  });

  it("retries a 429 on GET and gives up after maxRetries", async () => {
    let calls = 0;
    const http = client(async () => {
      calls++;
      return new Response("rate limited", { status: 429 });
    });

    await expect(http.json({ method: "GET", path: "/api/v1/files" })).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(3); // the original plus two retries
  });

  it("does NOT retry a 429 on POST - the API has no idempotency keys", async () => {
    let calls = 0;
    const http = client(async () => {
      calls++;
      return new Response("rate limited", { status: 429 });
    });

    await expect(http.json({ method: "POST", path: "/api/v1/files", jsonBody: {} })).rejects.toMatchObject({
      status: 429,
    });
    expect(calls).toBe(1);
  });

  it("retries a POST only when it opts in", async () => {
    let calls = 0;
    const http = client(async () => {
      calls++;
      return calls < 2 ? new Response("rate limited", { status: 429 }) : new Response("{}", { status: 200 });
    });

    await http.json({ method: "POST", path: "/api/v1/files", jsonBody: {}, retryable: true });
    expect(calls).toBe(2);
  });

  it("does not set Content-Type on multipart bodies (fetch owns the boundary)", async () => {
    let headers: Record<string, string> = {};
    const http = client(async (_url, init) => {
      headers = init.headers as Record<string, string>;
      return new Response("{}", { status: 200 });
    });

    const form = new FormData();
    form.append("file", new Blob(["%PDF-1.4"]), "a.pdf");
    await http.json({ method: "POST", path: "/api/v1/files", formBody: form });

    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("treats an empty success body as undefined rather than throwing", async () => {
    const http = client(async () => new Response("", { status: 200 }));
    await expect(http.jsonOrUndefined({ method: "PUT", path: "/x" })).resolves.toBeUndefined();
  });
});

describe("loadConfig", () => {
  it("refuses to start without a key, naming the env var", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/EVERYPAGE_API_KEY/);
  });

  it("rejects a token that is obviously not an EveryPage credential", () => {
    expect(() => loadConfig({ EVERYPAGE_API_KEY: "sk-abc123" } as NodeJS.ProcessEnv)).toThrow(/ep_live_/);
  });

  it("accepts both API keys and OAuth access tokens", () => {
    expect(loadConfig({ EVERYPAGE_API_KEY: "ep_live_a" } as NodeJS.ProcessEnv).apiKey).toBe("ep_live_a");
    expect(loadConfig({ EVERYPAGE_API_KEY: "ep_at_b" } as NodeJS.ProcessEnv).apiKey).toBe("ep_at_b");
  });

  it("defaults the base URL and strips trailing slashes from an override", () => {
    expect(loadConfig({ EVERYPAGE_API_KEY: "ep_live_a" } as NodeJS.ProcessEnv).baseUrl).toBe("https://everypage.co");
    expect(
      loadConfig({ EVERYPAGE_API_KEY: "ep_live_a", EVERYPAGE_BASE_URL: "http://localhost:8080///" } as NodeJS.ProcessEnv)
        .baseUrl,
    ).toBe("http://localhost:8080");
  });

  it("reads the read-only flag in the shapes people actually write", () => {
    const read = (value: string): boolean =>
      loadConfig({ EVERYPAGE_API_KEY: "ep_live_a", EVERYPAGE_READ_ONLY: value } as NodeJS.ProcessEnv).readOnly;
    expect(read("true")).toBe(true);
    expect(read("TRUE")).toBe(true);
    expect(read("1")).toBe(true);
    expect(read("yes")).toBe(true);
    expect(read("false")).toBe(false);
    expect(read("")).toBe(false);
  });
});
