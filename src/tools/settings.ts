/**
 * The share-settings input, shared by `everypage_share_pdf` (apply at
 * creation) and `everypage_update_file_settings` (change later).
 *
 * Canonical names come from AUTOMATION-MATRIX.md §3 and are identical across
 * every integration. Two names differ from the wire on purpose, and both are
 * blessed exceptions in that table: `passcode` -> `password` (never call it
 * "password" in a user-facing surface - it is not an account credential), and
 * `expiryHours` -> `deleteAt` (a model reasons about "expires in 48 hours"
 * far more reliably than it composes an RFC 3339 timestamp).
 *
 * Descriptions carry the plan tier in plain prose. They are spent on every
 * request, so they stay terse and skip the pricing URL - the 403 mapping
 * supplies that at the moment it matters.
 */

import { z } from "zod";

export const VIEWER_MODES = ["standard", "flipbook", "swipe", "magazine"] as const;

export const settingsSchema = {
  passcode: z
    .string()
    .optional()
    .describe("Require this passcode to open the document. Requires the Basic plan or higher."),
  allowDownload: z.boolean().optional().describe("Let readers download the original PDF."),
  expiryHours: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Expire the link this many hours from now. Capped by plan: 7 days on free, 365 days on basic, unlimited on pro.",
    ),
  neverExpire: z
    .boolean()
    .optional()
    .describe("Keep the link alive permanently. Overrides expiryHours. Requires the Pro plan."),
  viewerMode: z
    .enum(VIEWER_MODES)
    .optional()
    .describe("How the document is presented: standard scroll, page-turning flipbook, swipe, or magazine spread."),
  notifyOnView: z
    .boolean()
    .optional()
    .describe("Email the owner when someone reads the document. Requires the Basic plan or higher."),
  viewLimit: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Burn the link after this many views. 0 clears the limit. Requires the Basic plan or higher.",
    ),
  askReceipt: z
    .boolean()
    .optional()
    .describe("Ask readers to confirm they received the document. Requires the Basic plan or higher."),
  requireEmail: z
    .boolean()
    .optional()
    .describe("Make readers give an email address before they can read. Requires the Pro plan."),
  gateDomains: z
    .array(z.string())
    .optional()
    .describe(
      "Restrict the email gate to these domains, e.g. [\"acme.com\"]. An empty array clears the restriction. Requires the Pro plan.",
    ),
  watermark: z.boolean().optional().describe("Stamp the reader's identity across the pages. Requires the Pro plan."),
  pageFrom: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "First page readers may see (1-based). Pair with pageTo. Pages outside the window are never sent to the browser. Requires the Pro plan.",
    ),
  pageTo: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Last page readers may see. Set pageFrom and pageTo to 0 to clear the limit (clearing is never plan-gated)."),
  slug: z
    .string()
    .optional()
    .describe(
      "Vanity link name on the owner's custom domain: lowercase letters, digits and hyphens. Requires the Pro plan.",
    ),
};

export type SettingsInput = {
  [K in keyof typeof settingsSchema]?: z.infer<(typeof settingsSchema)[K]>;
};

/** `update` adds the passcode-clearing lane, which makes no sense at creation. */
export const updateOnlySchema = {
  clearPasscode: z
    .boolean()
    .optional()
    .describe("Remove the passcode so anyone with the link can read. Wins over passcode if both are given."),
};

export interface SettingsPayload {
  [key: string]: unknown;
}

export interface BuiltSettings {
  payload: SettingsPayload;
  /** Human-readable list of what is being changed, for the result text. */
  applied: string[];
}

/**
 * Translates the canonical input into the wire payload.
 *
 * Two rules are load-bearing, both learned the hard way on Make
 * (AUTOMATION-MATRIX.md §7.9):
 *
 *  - Only keys the caller actually set are emitted. The settings PUT treats a
 *    present-but-empty `viewerSettings` as "replace the blob with {}" and an
 *    empty `pageRange` as `{0,0}` - so sending a key "just in case" silently
 *    destroys settings.
 *  - `pageRange` is only sent when at least one of pageFrom/pageTo was given.
 */
export function buildSettingsPayload(
  input: SettingsInput & { clearPasscode?: boolean },
  now: Date = new Date(),
): BuiltSettings {
  const payload: SettingsPayload = {};
  const applied: string[] = [];

  if (input.clearPasscode) {
    payload.password = "";
    applied.push("passcode removed");
  } else if (input.passcode !== undefined) {
    payload.password = input.passcode;
    applied.push(input.passcode === "" ? "passcode removed" : "passcode set");
  }

  if (input.allowDownload !== undefined) {
    payload.allowDownload = input.allowDownload;
    applied.push(input.allowDownload ? "downloads allowed" : "downloads blocked");
  }

  // neverExpire overrides deleteAt server-side; sending both would be
  // ambiguous to a reader of the payload, so express the caller's intent.
  if (input.neverExpire) {
    payload.neverExpire = true;
    applied.push("never expires");
  } else if (input.expiryHours !== undefined) {
    payload.deleteAt = new Date(now.getTime() + input.expiryHours * 3600_000).toISOString();
    applied.push(`expires in ${input.expiryHours}h`);
  } else if (input.neverExpire === false) {
    payload.neverExpire = false;
    applied.push("expiry re-enabled");
  }

  if (input.viewerMode !== undefined) {
    payload.viewerMode = input.viewerMode;
    applied.push(`viewer mode ${input.viewerMode}`);
  }
  if (input.notifyOnView !== undefined) {
    payload.notifyOnView = input.notifyOnView;
    applied.push(input.notifyOnView ? "view notifications on" : "view notifications off");
  }
  if (input.viewLimit !== undefined) {
    payload.viewLimit = input.viewLimit;
    applied.push(input.viewLimit === 0 ? "view limit cleared" : `view limit ${input.viewLimit}`);
  }
  if (input.askReceipt !== undefined) {
    payload.askReceipt = input.askReceipt;
    applied.push(input.askReceipt ? "receipt requested" : "receipt not requested");
  }
  if (input.requireEmail !== undefined) {
    payload.requireEmail = input.requireEmail;
    applied.push(input.requireEmail ? "email gate on" : "email gate off");
  }
  if (input.gateDomains !== undefined) {
    const domains = input.gateDomains.map((d) => d.trim()).filter(Boolean);
    payload.gateDomains = domains;
    applied.push(domains.length ? `email gate limited to ${domains.join(", ")}` : "email domain limit cleared");
  }
  if (input.watermark !== undefined) {
    payload.watermark = input.watermark;
    applied.push(input.watermark ? "watermark on" : "watermark off");
  }
  if (input.slug !== undefined) {
    payload.slug = input.slug;
    applied.push(input.slug === "" ? "vanity slug cleared" : `vanity slug "${input.slug}"`);
  }

  if (input.pageFrom !== undefined || input.pageTo !== undefined) {
    const from = input.pageFrom ?? 0;
    const to = input.pageTo ?? 0;
    payload.pageRange = { from, to };
    applied.push(from === 0 && to === 0 ? "page range cleared" : `pages ${from}-${to} only`);
  }

  return { payload, applied };
}
