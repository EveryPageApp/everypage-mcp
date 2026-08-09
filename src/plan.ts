/**
 * Plan awareness.
 *
 * Two uses: pre-flighting an upload against the account's size cap (so a 2 GiB
 * file doesn't transfer in full just to earn a 413), and enriching plan-gate
 * 403s with the plan the account is actually on.
 *
 * Caps mirror backend/internal/handlers/files.go (MaxFileSize*, MaxFiles*) and
 * the pricing page. They are a client-side courtesy only - the server stays
 * authoritative, and a cap that drifts here must never widen access.
 */

import type { HttpClient } from "./http.js";

export type PlanName = "free" | "basic" | "pro";

export interface PlanCaps {
  maxUploadBytes: number;
  maxUploadLabel: string;
  /** null = unlimited. */
  maxActiveFiles: number | null;
}

export const PLAN_CAPS: Record<PlanName, PlanCaps> = {
  free: { maxUploadBytes: 20 * 1024 * 1024, maxUploadLabel: "20 MiB", maxActiveFiles: 3 },
  basic: { maxUploadBytes: 200 * 1024 * 1024, maxUploadLabel: "200 MiB", maxActiveFiles: 100 },
  pro: { maxUploadBytes: 2 * 1024 * 1024 * 1024, maxUploadLabel: "2 GiB", maxActiveFiles: null },
};

/** Which tier each gated capability needs, for `everypage_account`'s report. */
export const FEATURE_TIERS: { feature: string; tier: Exclude<PlanName, "free"> }[] = [
  { feature: "Passcode-protect a link", tier: "basic" },
  { feature: "Email notification when a document is viewed", tier: "basic" },
  { feature: "View limit (burn after N views)", tier: "basic" },
  { feature: "Read receipts", tier: "basic" },
  { feature: "Per-page readership statistics", tier: "basic" },
  { feature: "Never-expire links", tier: "pro" },
  { feature: "Email-capture gate (and the gate event stream)", tier: "pro" },
  { feature: "Per-recipient link variants", tier: "pro" },
  { feature: "Replace a document's content in place", tier: "pro" },
  { feature: "Watermarking", tier: "pro" },
  { feature: "Page-range limits", tier: "pro" },
  { feature: "Vanity slugs on a custom domain", tier: "pro" },
  { feature: "Reader identities and live presence", tier: "pro" },
];

export interface Account {
  name?: string;
  email?: string;
  subscription?: string;
  isAdmin?: boolean;
  created_at?: string;
}

export function normalizePlan(raw: string | undefined): PlanName {
  return raw === "basic" || raw === "pro" ? raw : "free";
}

/**
 * Caches `GET /user` for the process lifetime. The plan can change mid-session
 * (someone upgrades in another tab), but the only consequences of a stale
 * value are a pre-flight that is too strict and a 403 message naming the old
 * plan - both self-correcting, and neither worth a request per tool call.
 */
export class PlanCache {
  readonly #http: HttpClient;
  #pending: Promise<Account> | null = null;
  #account: Account | null = null;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  async account(): Promise<Account> {
    if (this.#account) return this.#account;
    this.#pending ??= this.#http
      .json<Account>({ method: "GET", path: "/api/v1/user" })
      .then((account) => {
        this.#account = account;
        return account;
      })
      .finally(() => {
        this.#pending = null;
      });
    return this.#pending;
  }

  /** The plan, or null if it could not be fetched - never throws. */
  async planOrNull(): Promise<PlanName | null> {
    try {
      return normalizePlan((await this.account()).subscription);
    } catch {
      return null;
    }
  }

  /**
   * Caps for pre-flight checks. Falls back to the *pro* caps when the plan is
   * unknown, deliberately: an unknown plan must not manufacture a client-side
   * refusal the server would have allowed. Being too permissive here just
   * means the server answers 413, which is mapped clearly.
   */
  async caps(): Promise<{ plan: PlanName | null; caps: PlanCaps }> {
    const plan = await this.planOrNull();
    return { plan, caps: plan ? PLAN_CAPS[plan] : PLAN_CAPS.pro };
  }
}
