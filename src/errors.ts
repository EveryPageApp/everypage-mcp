/**
 * Turning HTTP failures into something a model can act on.
 *
 * Two rules drive everything here:
 *
 *  1. Never throw out of a tool handler. A thrown error reaches the model as
 *     an opaque transport failure; an `isError` result reaches it as text it
 *     can read and respond to.
 *  2. Every message ends in what to do next - retry, don't retry, upgrade,
 *     verify the id. A model that is only told "403" will loop.
 *
 * The status semantics are pinned by integrations/AUTOMATION-MATRIX.md §5;
 * the wording here is the MCP column of that table.
 */

import { EveryPageApiError } from "./http.js";
import { PLAN_CAPS, type PlanName } from "./plan.js";

const PRICING_URL = "https://everypage.co/pricing";
const ACCOUNT_URL = "https://everypage.co/account";

/**
 * Error results carry NO `structuredContent`, deliberately.
 *
 * The MCP client validates `structuredContent` against the tool's declared
 * output schema whenever it is present - it does NOT skip that check for
 * error results, despite a comment in the SDK saying otherwise. An error
 * payload never matches a success schema, so attaching one turns every
 * carefully-worded failure into an opaque `-32602` protocol exception that
 * the model never sees. Everything machine-readable therefore goes into the
 * text, on the last line.
 */
export interface ToolError {
  // Matches the SDK's CallToolResult, which permits extra keys.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError: true;
}

export interface ErrorContext {
  /** What the tool was doing, e.g. "creating a link variant". */
  action?: string;
  /** The scope the endpoint wanted, for `insufficient_scope` bodies. */
  scope?: string;
  /** The account's plan, when already known - enriches plan-gate messages. */
  plan?: PlanName | null;
  /** Overrides for the default 409 sentence, keyed by nothing - just a hint. */
  conflictHint?: string;
}

/** Matches the backend's "This feature requires the pro plan or higher" family. */
const PLAN_GATE = /requires the (basic|pro) plan/i;

function planCapsSentence(): string {
  return (
    `Upload caps are ${PLAN_CAPS.free.maxUploadLabel} on free, ` +
    `${PLAN_CAPS.basic.maxUploadLabel} on basic and ${PLAN_CAPS.pro.maxUploadLabel} on pro.`
  );
}

function describe(status: number, body: string, ctx: ErrorContext): { text: string; retryable: boolean } {
  const raw = body.trim();
  const quoted = raw ? `EveryPage said: "${raw}".` : "";
  const doing = ctx.action ? ` while ${ctx.action}` : "";
  const plan = ctx.plan ?? null;

  switch (status) {
    case 401:
      return {
        retryable: false,
        text:
          "Your EveryPage API key is invalid or has been revoked. " +
          `Check the EVERYPAGE_API_KEY value in this MCP server's configuration, or create a fresh key at ${ACCOUNT_URL}. ` +
          "Do not retry with the same key - it will keep failing.",
      };

    case 403: {
      const gate = PLAN_GATE.exec(raw);
      if (gate) {
        const needed = gate[1]!.toLowerCase();
        const current = plan ? ` This account is on the ${plan} plan.` : "";
        return {
          retryable: false,
          text:
            `${quoted} That feature needs the ${needed} plan or higher.${current} ` +
            `Tell the user they can upgrade at ${PRICING_URL}, or retry without the ${needed}-only options. ` +
            "Retrying the same call unchanged will not help.",
        };
      }
      if (/insufficient_scope/i.test(raw)) {
        const needed = ctx.scope ? ` (needs \`${ctx.scope}\`)` : "";
        return {
          retryable: false,
          text:
            `The OAuth access token lacks the scope this call requires${needed}. ${quoted} ` +
            "A personal API key (`ep_live_...`) holds every scope - if the user controls the account, " +
            `they can create one at ${ACCOUNT_URL}.`,
        };
      }
      return {
        retryable: false,
        text:
          `That action is not allowed on this plan or account${doing}. ${quoted} ` +
          "Common causes: the document belongs to someone else, or an account cap is full " +
          "(3 files on free, 100 on basic; 25 webhooks; per-file variant cap).",
      };
    }

    case 404:
      return {
        retryable: false,
        text:
          `Not found${doing}. ${quoted} ` +
          "Note that the EveryPage API deliberately answers 404 - not 403 - for documents that exist but belong to a " +
          "different account, so this does not prove the id is wrong. Verify it with `everypage_list_files` " +
          "before trying again; if the user pasted a link, it may not be theirs.",
      };

    case 409:
      return {
        retryable: false,
        text:
          `Conflict${doing}. ${quoted} ` +
          (ctx.conflictHint ??
            "Usually: the vanity slug is already used by another of your documents, the variant was GDPR-redacted " +
            "(its label can never be set again), or the content changed concurrently."),
      };

    case 410:
      return {
        retryable: false,
        text:
          `That link is no longer live - it either expired or was burned by its view limit. ${quoted} ` +
          "Settings changes cannot revive it. A *burned* link can be brought back with `everypage_replace_content`; " +
          "an *expired* one cannot - upload the document again instead.",
      };

    case 413:
      return {
        retryable: false,
        text:
          `That PDF is larger than this plan allows. ${quoted} ${planCapsSentence()} ` +
          `Send a smaller file, or upgrade at ${PRICING_URL}.`,
      };

    case 429:
      return {
        retryable: true,
        text:
          "Rate limited by EveryPage (120 requests per minute per key; webhook tests are 10 per minute). " +
          "Reads were already retried automatically and still hit the limit. Wait about 60 seconds before trying again.",
      };

    default:
      return {
        retryable: status >= 500,
        text:
          `Unexpected EveryPage response (${status})${doing}. ${quoted}` +
          (status >= 500 ? " This is a server-side fault; retrying in a moment may work." : ""),
      };
  }
}

/**
 * A single machine-readable line appended to every failure, so a scripted
 * agent can branch without parsing the prose above it.
 */
function detailLine(status: number | null, retryable: boolean, plan: PlanName | null): string {
  const fields = [`status=${status ?? "none"}`, `retryable=${retryable}`];
  if (plan) fields.push(`plan=${plan}`);
  return `[everypage ${fields.join(" ")}]`;
}

/** Maps any thrown value into an `isError` tool result. */
export function toToolError(err: unknown, ctx: ErrorContext = {}): ToolError {
  const plan = ctx.plan ?? null;

  if (err instanceof EveryPageApiError) {
    const { text, retryable } = describe(err.status, err.body, ctx);
    return {
      content: [{ type: "text", text: `${text}\n\n${detailLine(err.status, retryable, plan)}` }],
      isError: true,
    };
  }

  // Not an API error: a local failure (missing file, bad PDF, a network
  // stack error). Those messages are written for a model where they are
  // thrown, so pass them through unchanged.
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `${message}\n\n${detailLine(null, false, plan)}` }],
    isError: true,
  };
}

/**
 * A failure the tool itself detected (not the API): a missing file, a
 * non-PDF, an over-cap upload. Thrown so tool bodies can bail from anywhere,
 * caught by the same wrapper that catches API errors.
 */
export class ToolInputError extends Error {
  override readonly name = "ToolInputError";
}

/** Short one-line form of an error, for `warnings[]` on partial success. */
export function warningText(err: unknown, ctx: ErrorContext = {}): string {
  if (err instanceof EveryPageApiError) {
    const gate = PLAN_GATE.exec(err.body);
    if (gate) return `${err.body.trim()} (needs the ${gate[1]!.toLowerCase()} plan)`;
    return err.body.trim() || `HTTP ${err.status}`;
  }
  return err instanceof Error ? err.message : String(err);
}
