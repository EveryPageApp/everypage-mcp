/**
 * Server assembly. Kept separate from `cli.ts` so tests can build a server
 * and drive it over an in-memory transport without spawning a process.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Config } from "./config.js";
import { HttpClient, type FetchLike } from "./http.js";
import { PlanCache } from "./plan.js";
import { registerPrompts } from "./prompts/prompts.js";
import { registerFileTools } from "./tools/files.js";
import { registerReadershipTools } from "./tools/readership.js";
import { registerVariantTools } from "./tools/variants.js";
import { registerWebhookTools } from "./tools/webhooks.js";
import type { ToolContext } from "./tools/context.js";

export const SERVER_NAME = "everypage";
export const SERVER_VERSION = "1.1.0";

export interface BuildOptions {
  /** Injectable fetch, for tests. */
  fetchFn?: FetchLike;
  /** Injectable sleep, so tests don't wait out 429 backoff. */
  sleepFn?: (ms: number) => Promise<void>;
}

export function buildServer(config: Config, options: BuildOptions = {}): McpServer {
  const http = new HttpClient({
    token: config.apiKey,
    baseUrl: config.baseUrl,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.sleepFn ? { sleepFn: options.sleepFn } : {}),
  });

  const ctx: ToolContext = {
    http,
    plans: new PlanCache(http),
    config,
    baseUrl: config.baseUrl,
    // Same injection point as `http`, but without the Authorization header -
    // this one talks to hosts the user named.
    plainFetch: options.fetchFn
      ? (url, init) => options.fetchFn!(url, init ?? {})
      : (url, init) => globalThis.fetch(url, init),
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "EveryPage turns a PDF into a tracked share link: you learn who opened it, how long they spent, how far " +
        "they got, and where they stopped reading.\n\n" +
        "Start with everypage_share_pdf to publish a document (it takes a local file path or an https URL and " +
        "returns the link, an embed snippet and a QR code URL in one call). Use everypage_get_readership to answer " +
        "\"did they read it?\" for a specific document, and everypage_list_events to see recent activity across all " +
        "of them.\n\n" +
        "Any tool that takes a document accepts its UUID, its short link id, or a share URL pasted from the browser - " +
        "there is no need to look up an id first.\n\n" +
        "Features are plan-gated (free, basic, pro); a refusal will say which plan is needed. " +
        "everypage_account reports the current plan and what it allows.",
    },
  );

  registerFileTools(server, ctx);
  registerReadershipTools(server, ctx);
  registerVariantTools(server, ctx);
  registerWebhookTools(server, ctx);
  registerPrompts(server);

  return server;
}
