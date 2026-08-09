/**
 * What every tool needs, and the wrapper that keeps them all honest.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Config } from "../config.js";
import type { HttpClient } from "../http.js";
import type { PlanCache } from "../plan.js";
import { toToolError, type ErrorContext } from "../errors.js";

export interface ToolContext {
  http: HttpClient;
  plans: PlanCache;
  config: Config;
  /** Convenience: `config.baseUrl`, the `{base}` of every share-trio URL. */
  baseUrl: string;
  /**
   * A bare fetch for reaching hosts the USER named, used by the import lane.
   * Deliberately separate from `http`, which attaches the API key: that key
   * must never travel to a third-party host.
   */
  plainFetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * A tool result. The index signature matches the SDK's `CallToolResult`,
 * which allows arbitrary extra keys - without it TypeScript refuses every
 * handler as structurally incompatible.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Builds a plain success result. */
export function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return structured ? { content: [{ type: "text", text }], structuredContent: structured } : { content: [{ type: "text", text }] };
}

/**
 * Wraps a tool body so no exception ever escapes as a transport error.
 *
 * The plan is looked up lazily and passed into the error mapper, so a 403
 * can say "this account is on the free plan" without every tool remembering
 * to fetch it. The lookup itself can fail (offline, revoked key) and that is
 * fine - `planOrNull` swallows it and the message just omits the clause.
 */
export function guard<T extends unknown[]>(
  ctx: ToolContext,
  errorContext: ErrorContext,
  body: (...args: T) => Promise<ToolResult>,
): (...args: T) => Promise<ToolResult> {
  return async (...args: T) => {
    try {
      return await body(...args);
    } catch (err) {
      const plan = await ctx.plans.planOrNull();
      return toToolError(err, { ...errorContext, plan });
    }
  };
}

/**
 * The share trio, as an output-schema fragment. Every file-producing tool
 * mixes this in so the keys stay identical across tools (and identical to the
 * other integrations - AUTOMATION-MATRIX.md §1).
 */
export const trioSchema = {
  uuid: z.string().describe("The document's canonical UUID."),
  shortId: z.string().optional().describe("The document's short share-URL alias."),
  fileName: z.string().optional().describe("The document's display name."),
  shareUrl: z.string().describe("The tracked share link to send to a reader."),
  qr_url: z.string().describe("PNG QR code for the share link. Public - no credentials needed to fetch it."),
  embed_code: z.string().describe("Ready-to-paste <iframe> that embeds the document."),
};

/** Warnings ride alongside a successful result; they are never errors. */
export const warningsSchema = z
  .array(z.string())
  .optional()
  .describe("Non-fatal problems. The operation succeeded; these describe what could not be applied.");

export type Registrar = (server: McpServer, ctx: ToolContext) => void;
