import { describe, expect, it } from "vitest";

import { extractIdentifier, isUuid } from "../src/resolve.js";
import { embedCode, qrUrl, shareTrio } from "../src/share-url.js";
import { buildSettingsPayload } from "../src/tools/settings.js";
import { steepestDrop } from "../src/tools/readership.js";
import { bar, humanBytes, humanDuration, relativeTime, sample } from "../src/format.js";
import { toToolError } from "../src/errors.js";
import { EveryPageApiError } from "../src/http.js";

const BASE = "https://everypage.co";

describe("extractIdentifier", () => {
  it("passes a bare uuid or short id straight through", () => {
    expect(extractIdentifier("aB3xY9kQ2mZ7")).toBe("aB3xY9kQ2mZ7");
    expect(extractIdentifier("  aB3xY9kQ2mZ7  ")).toBe("aB3xY9kQ2mZ7");
  });

  it("strips the share, embed, configure and readership URL shapes", () => {
    expect(extractIdentifier("https://everypage.co/aB3xY9kQ2mZ7")).toBe("aB3xY9kQ2mZ7");
    expect(extractIdentifier("https://everypage.co/embed/aB3xY9kQ2mZ7")).toBe("aB3xY9kQ2mZ7");
    expect(extractIdentifier("https://everypage.co/aB3xY9kQ2mZ7/configure")).toBe("aB3xY9kQ2mZ7");
    expect(extractIdentifier("https://everypage.co/readership/aB3xY9kQ2mZ7")).toBe("aB3xY9kQ2mZ7");
    expect(extractIdentifier("/embed/aB3xY9kQ2mZ7")).toBe("aB3xY9kQ2mZ7");
  });

  it("drops query strings and fragments - share links carry ?via=", () => {
    expect(extractIdentifier("https://everypage.co/aB3xY9kQ2mZ7?via=email")).toBe("aB3xY9kQ2mZ7");
    expect(extractIdentifier("https://everypage.co/aB3xY9kQ2mZ7#page=3")).toBe("aB3xY9kQ2mZ7");
  });

  it("handles a custom domain", () => {
    expect(extractIdentifier("https://docs.acme.com/2026-pricing")).toBe("2026-pricing");
  });

  it("recognises uuids case-insensitively", () => {
    expect(isUuid("11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(isUuid("11111111-2222-3333-4444-55555555555Z")).toBe(false);
    expect(isUuid("aB3xY9kQ2mZ7")).toBe(false);
  });
});

describe("share trio", () => {
  it("prefers the short id for human-facing links but never for the QR", () => {
    const trio = shareTrio(BASE, { uuid: "u-u-i-d", shortId: "aB3xY9kQ2mZ7" });
    expect(trio.shareUrl).toBe("https://everypage.co/aB3xY9kQ2mZ7");
    expect(trio.embed_code).toContain("https://everypage.co/embed/aB3xY9kQ2mZ7");
    // The QR endpoint is uuid-keyed and lives on the canonical host.
    expect(trio.qr_url).toBe("https://everypage.co/api/files/u-u-i-d/qr-code");
  });

  it("falls back to the uuid when a file predates short ids", () => {
    const trio = shareTrio(BASE, { uuid: "u-u-i-d" });
    expect(trio.shareUrl).toBe("https://everypage.co/u-u-i-d");
    expect(trio.embed_code).toContain("/embed/u-u-i-d");
  });

  it("never uses a vanity slug, even when the file has one", () => {
    // Slugs are renameable and custom-domain-only; trio URLs land in frozen
    // places. The builder takes no slug at all - this pins that.
    const trio = shareTrio(BASE, { uuid: "u-u-i-d", shortId: "aB3xY9kQ2mZ7" });
    expect(JSON.stringify(trio)).not.toContain("slug");
  });

  it("emits an embed iframe with the fixed dimensions the other integrations use", () => {
    expect(embedCode(BASE, { uuid: "u", shortId: "s" })).toBe(
      '<iframe src="https://everypage.co/embed/s" width="800" height="600" frameborder="0" allowfullscreen></iframe>',
    );
  });

  it("puts the QR on the public path so a consumer needs no credentials", () => {
    expect(qrUrl(BASE, { uuid: "u" })).toBe("https://everypage.co/api/files/u/qr-code");
  });
});

describe("buildSettingsPayload", () => {
  const now = new Date("2026-08-09T12:00:00Z");

  it("emits nothing at all when nothing was set", () => {
    // Load-bearing: an empty `viewerSettings` wipes the blob, and an empty
    // pageRange clears the range. Sending a key "just in case" destroys data.
    expect(buildSettingsPayload({}, now).payload).toEqual({});
  });

  it("translates expiryHours into an absolute deleteAt", () => {
    const { payload } = buildSettingsPayload({ expiryHours: 48 }, now);
    expect(payload.deleteAt).toBe("2026-08-11T12:00:00.000Z");
  });

  it("lets neverExpire win over expiryHours", () => {
    const { payload } = buildSettingsPayload({ neverExpire: true, expiryHours: 48 }, now);
    expect(payload.neverExpire).toBe(true);
    expect(payload.deleteAt).toBeUndefined();
  });

  it("maps passcode onto the wire's password field", () => {
    expect(buildSettingsPayload({ passcode: "hunter2" }, now).payload.password).toBe("hunter2");
  });

  it("lets clearPasscode win over a passcode given in the same call", () => {
    const { payload } = buildSettingsPayload({ passcode: "hunter2", clearPasscode: true }, now);
    expect(payload.password).toBe("");
  });

  it("only sends pageRange when a page bound was actually given", () => {
    expect(buildSettingsPayload({ allowDownload: true }, now).payload.pageRange).toBeUndefined();
    expect(buildSettingsPayload({ pageFrom: 2, pageTo: 5 }, now).payload.pageRange).toEqual({ from: 2, to: 5 });
    // {0,0} is the documented "clear the range" signal.
    expect(buildSettingsPayload({ pageFrom: 0, pageTo: 0 }, now).payload.pageRange).toEqual({ from: 0, to: 0 });
  });

  it("filters blank entries out of gateDomains", () => {
    const { payload } = buildSettingsPayload({ gateDomains: ["acme.com", "  ", ""] }, now);
    expect(payload.gateDomains).toEqual(["acme.com"]);
  });

  it("describes each change in prose for the result text", () => {
    const { applied } = buildSettingsPayload({ passcode: "x", allowDownload: false, expiryHours: 24 }, now);
    expect(applied).toEqual(["passcode set", "downloads blocked", "expires in 24h"]);
  });
});

describe("steepestDrop", () => {
  it("finds the page that loses the largest share of readers", () => {
    const drop = steepestDrop([
      { page: 1, reached: 100, pct: 100 },
      { page: 2, reached: 90, pct: 90 },
      { page: 3, reached: 50, pct: 50 }, // -44%
      { page: 4, reached: 45, pct: 45 },
    ]);
    expect(drop).toEqual({ page: 3, lostPct: expect.closeTo(44.4, 1) });
  });

  it("returns null for a funnel nobody abandons", () => {
    expect(
      steepestDrop([
        { page: 1, reached: 10, pct: 100 },
        { page: 2, reached: 10, pct: 100 },
      ]),
    ).toBeNull();
  });

  it("returns null for an empty or single-point funnel", () => {
    expect(steepestDrop([])).toBeNull();
    expect(steepestDrop([{ page: 1, reached: 5, pct: 100 }])).toBeNull();
  });

  it("ignores a zero-reach predecessor rather than dividing by zero", () => {
    expect(
      steepestDrop([
        { page: 1, reached: 0, pct: 0 },
        { page: 2, reached: 0, pct: 0 },
      ]),
    ).toBeNull();
  });
});

describe("formatting", () => {
  it("humanizes durations the way a person would say them", () => {
    expect(humanDuration(0)).toBe("0s");
    expect(humanDuration(45_000)).toBe("45s");
    expect(humanDuration(160_000)).toBe("2m 40s");
    expect(humanDuration(3_900_000)).toBe("1h 05m");
    expect(humanDuration(undefined)).toBe("0s");
  });

  it("humanizes byte counts", () => {
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(2_200_000)).toBe("2.1 MB");
    expect(humanBytes(undefined)).toBe("unknown size");
  });

  it("renders relative times in both directions", () => {
    const now = new Date("2026-08-09T12:00:00Z");
    expect(relativeTime("2026-07-28T12:00:00Z", now)).toBe("12 days ago");
    expect(relativeTime("2026-08-12T12:00:00Z", now)).toBe("in 3 days");
    expect(relativeTime(undefined, now)).toBe("unknown");
    expect(relativeTime("not a date", now)).toBe("unknown");
  });

  it("keeps first and last when sampling a long series", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const picked = sample(items, 8);
    expect(picked).toHaveLength(8);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(49);
    expect(sample([1, 2], 8)).toEqual([1, 2]);
  });

  it("clamps bar fractions instead of emitting negative-length strings", () => {
    expect(bar(-1, 10)).toBe("");
    expect(bar(1, 10)).toBe("█".repeat(10));
    expect(bar(Number.NaN, 10)).toBe("");
  });
});

describe("toToolError", () => {
  const err = (status: number, body: string) => new EveryPageApiError(status, body);

  it("tells the model not to retry a 401", () => {
    const result = toToolError(err(401, "Invalid or expired token"));
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/EVERYPAGE_API_KEY/);
    expect(result.content[0]!.text).toMatch(/Do not retry/i);
  });

  it("never attaches structuredContent - the client would reject it", () => {
    // An error payload cannot match a success output schema, and the SDK
    // client validates any structuredContent it is given regardless of
    // isError. Attaching one turns a readable failure into an opaque -32602.
    for (const status of [401, 403, 404, 409, 410, 413, 429, 500]) {
      expect(toToolError(err(status, "nope")).structuredContent).toBeUndefined();
    }
    expect(toToolError(new Error("local failure")).structuredContent).toBeUndefined();
  });

  it("names the required tier and the current plan on a plan gate", () => {
    const result = toToolError(err(403, "This feature requires the pro plan or higher"), { plan: "free" });
    expect(result.content[0]!.text).toMatch(/pro plan or higher/);
    expect(result.content[0]!.text).toMatch(/on the free plan/);
    expect(result.content[0]!.text).toMatch(/pricing/);
  });

  it("explains that a 404 can mean someone else's document", () => {
    // Without this the model retries the same id forever.
    const result = toToolError(err(404, "File not found"));
    expect(result.content[0]!.text).toMatch(/different account/);
    expect(result.content[0]!.text).toMatch(/everypage_list_files/);
  });

  it("distinguishes a burned link from an expired one on 410", () => {
    const result = toToolError(err(410, "gone"));
    expect(result.content[0]!.text).toMatch(/everypage_replace_content/);
  });

  it("explains that API keys hold every scope on insufficient_scope", () => {
    const result = toToolError(err(403, "insufficient_scope: requires files:write"), { scope: "files:write" });
    expect(result.content[0]!.text).toMatch(/files:write/);
    expect(result.content[0]!.text).toMatch(/ep_live_/);
  });

  it("ends every failure with a machine-readable detail line", () => {
    // Scripted agents branch on this instead of parsing the prose.
    expect(toToolError(err(429, "")).content[0]!.text).toMatch(/\[everypage status=429 retryable=true\]$/);
    expect(toToolError(err(403, "requires the pro plan"), { plan: "free" }).content[0]!.text).toMatch(
      /\[everypage status=403 retryable=false plan=free\]$/,
    );
    expect(toToolError(new Error("boom")).content[0]!.text).toMatch(/\[everypage status=none retryable=false\]$/);
  });

  it("always carries the raw body through for a human to read", () => {
    const result = toToolError(err(400, "viewLimit must be a non-negative integer"));
    expect(result.content[0]!.text).toContain("viewLimit must be a non-negative integer");
  });

  it("passes local (non-API) failures through unchanged", () => {
    const result = toToolError(new Error("No file exists at \"/tmp/nope.pdf\"."));
    expect(result.content[0]!.text).toContain("/tmp/nope.pdf");
  });
});
