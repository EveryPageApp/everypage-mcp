import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FILE_UUID, USER_ROUTE, fileRecord, harness, route, routeSequence, type Harness } from "./helpers.js";

let active: Harness | null = null;
afterEach(async () => {
  await active?.close();
  active = null;
});

async function pdfAt(name = "proposal.pdf", body = "%PDF-1.7\n...content..."): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "everypage-mcp-test-"));
  const path = join(dir, name);
  await writeFile(path, body);
  return path;
}

describe("everypage_share_pdf", () => {
  it("uploads a local PDF and returns the whole share trio in one call", async () => {
    const path = await pdfAt();
    const h = (active = await harness([
      USER_ROUTE,
      route("POST", "/api/v1/files", { body: { uuid: FILE_UUID, shortId: "aB3xY9kQ2mZ7" } }),
      route("GET", `/api/v1/files/${FILE_UUID}`, { body: fileRecord() }),
    ]));

    const result = await h.call("everypage_share_pdf", { path });
    const structured = result.structuredContent as Record<string, string>;

    expect(result.isError).toBeFalsy();
    expect(structured.shareUrl).toBe("https://everypage.test/aB3xY9kQ2mZ7");
    expect(structured.qr_url).toBe(`https://everypage.test/api/files/${FILE_UUID}/qr-code`);
    expect(structured.embed_code).toContain("/embed/aB3xY9kQ2mZ7");
    expect(h.text(result)).toContain("Share link: https://everypage.test/aB3xY9kQ2mZ7");
  });

  it("refuses a file that is not a PDF before any upload happens", async () => {
    const path = await pdfAt("notes.pdf", "This is plain text, not a PDF.");
    const h = (active = await harness([USER_ROUTE]));

    const result = await h.call("everypage_share_pdf", { path });

    expect(result.isError).toBe(true);
    expect(h.text(result)).toMatch(/not a PDF/);
    // The point of sniffing first: nothing was sent.
    expect(h.stub.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("refuses a file over the plan's cap without transferring it", async () => {
    const path = await pdfAt("big.pdf", "%PDF-1.7" + "x".repeat(40 * 1024 * 1024));
    const h = (active = await harness([
      route("GET", "/api/v1/user", { body: { subscription: "free" } }),
    ]));

    const result = await h.call("everypage_share_pdf", { path });

    expect(result.isError).toBe(true);
    expect(h.text(result)).toMatch(/exceeds the free plan's 20 MiB limit/);
    expect(h.stub.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("gives a clear error when the path does not exist", async () => {
    const h = (active = await harness([USER_ROUTE]));
    const result = await h.call("everypage_share_pdf", { path: "/tmp/definitely-not-here-9182.pdf" });
    expect(result.isError).toBe(true);
    expect(h.text(result)).toMatch(/No file exists at/);
  });

  it("insists on an absolute path", async () => {
    const h = (active = await harness([USER_ROUTE]));
    const result = await h.call("everypage_share_pdf", { path: "proposal.pdf" });
    expect(result.isError).toBe(true);
    expect(h.text(result)).toMatch(/not an absolute path/);
  });

  it("requires exactly one of path and url", async () => {
    const h = (active = await harness([USER_ROUTE]));
    expect(h.text(await h.call("everypage_share_pdf", {}))).toMatch(/Give either `path`/);
    expect(h.text(await h.call("everypage_share_pdf", { path: "/a.pdf", url: "https://x/y.pdf" }))).toMatch(
      /not both/,
    );
  });

  it("applies settings in the same call and reports them", async () => {
    const path = await pdfAt();
    let settingsBody: unknown;
    const h = (active = await harness([
      USER_ROUTE,
      route("POST", "/api/v1/files", { body: { uuid: FILE_UUID, shortId: "aB3xY9kQ2mZ7" } }),
      (req) => {
        if (req.method === "PUT" && req.path === `/api/v1/files/${FILE_UUID}/settings`) {
          settingsBody = req.body;
          return { status: 200, body: "" };
        }
        return undefined;
      },
      route("GET", `/api/v1/files/${FILE_UUID}`, { body: fileRecord({ protected: true }) }),
    ]));

    const result = await h.call("everypage_share_pdf", { path, passcode: "hunter2", allowDownload: false });

    expect(settingsBody).toEqual({ password: "hunter2", allowDownload: false });
    expect(h.text(result)).toMatch(/Settings applied: passcode set, downloads blocked/);
  });

  it("keeps the upload and warns when settings are refused by the plan", async () => {
    const path = await pdfAt();
    const h = (active = await harness([
      route("GET", "/api/v1/user", { body: { subscription: "free" } }),
      route("POST", "/api/v1/files", { body: { uuid: FILE_UUID, shortId: "aB3xY9kQ2mZ7" } }),
      route("PUT", `/api/v1/files/${FILE_UUID}/settings`, {
        status: 403,
        body: "This feature requires the pro plan or higher",
      }),
      route("GET", `/api/v1/files/${FILE_UUID}`, { body: fileRecord() }),
    ]));

    const result = await h.call("everypage_share_pdf", { path, requireEmail: true });

    // Throwing away a completed upload over a refused toggle is the worst
    // possible outcome - the link must survive with a warning.
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.shareUrl).toBe("https://everypage.test/aB3xY9kQ2mZ7");
    expect((structured.warnings as string[])[0]).toMatch(/pro plan/);
    expect(h.text(result)).toMatch(/uploaded and is live/);
  });

  it("fetches a URL without ever sending the API key to that host", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      (req) =>
        req.url === "https://cdn.example.com/deck.pdf"
          ? { body: "%PDF-1.7 remote bytes", headers: { "content-type": "application/pdf" } }
          : undefined,
      route("POST", "/api/v1/files", { body: { uuid: FILE_UUID, shortId: "aB3xY9kQ2mZ7" } }),
      route("GET", `/api/v1/files/${FILE_UUID}`, { body: fileRecord({ originalName: "deck.pdf" }) }),
    ]));

    const result = await h.call("everypage_share_pdf", { url: "https://cdn.example.com/deck.pdf" });

    expect(result.isError).toBeFalsy();
    expect(h.stub.foreign).toHaveLength(1);
    expect(h.stub.foreign[0]!.headers.authorization).toBeUndefined();
  });

  it("rejects a non-https source URL", async () => {
    const h = (active = await harness([USER_ROUTE]));
    const result = await h.call("everypage_share_pdf", { url: "http://cdn.example.com/deck.pdf" });
    expect(result.isError).toBe(true);
    expect(h.text(result)).toMatch(/Only https/);
    expect(h.stub.foreign).toHaveLength(0);
  });

  it("rejects a URL that serves something other than a PDF", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      (req) => (req.url.startsWith("https://cdn.example.com") ? { body: "<html>not a pdf</html>" } : undefined),
    ]));

    const result = await h.call("everypage_share_pdf", { url: "https://cdn.example.com/page.html" });
    expect(result.isError).toBe(true);
    expect(h.text(result)).toMatch(/not a PDF/);
  });
});

describe("identifier handling", () => {
  it("accepts a pasted share URL and resolves it to the canonical uuid", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("GET", "/api/v1/files/aB3xY9kQ2mZ7", { body: fileRecord() }),
    ]));

    const result = await h.call("everypage_get_file", { file: "https://everypage.co/aB3xY9kQ2mZ7?via=email" });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Record<string, string>).uuid).toBe(FILE_UUID);
    // Resolution went through the short id, not the pasted URL.
    expect(h.stub.requests.map((r) => r.path)).toContain("/api/v1/files/aB3xY9kQ2mZ7");
  });

  it("spends no round trip when given a uuid", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("GET", `/api/v1/files/${FILE_UUID}`, { body: fileRecord() }),
    ]));

    await h.call("everypage_get_file", { file: FILE_UUID });

    expect(h.stub.requests.filter((r) => r.path.startsWith("/api/v1/files/"))).toHaveLength(1);
  });

  it("resolves the short id to a uuid before a uuid-keyed write", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("GET", "/api/v1/files/aB3xY9kQ2mZ7", { body: fileRecord() }),
      route("PUT", `/api/v1/files/${FILE_UUID}/settings`, { status: 200, body: "" }),
      route("GET", `/api/v1/files/${FILE_UUID}`, { body: fileRecord({ allowDownload: false }) }),
    ]));

    const result = await h.call("everypage_update_file_settings", { file: "aB3xY9kQ2mZ7", allowDownload: false });

    expect(result.isError).toBeFalsy();
    expect(h.stub.requests.some((r) => r.method === "PUT" && r.path.includes(FILE_UUID))).toBe(true);
  });
});

describe("everypage_update_file_settings", () => {
  it("refuses a call that would change nothing", async () => {
    const h = (active = await harness([USER_ROUTE]));
    const result = await h.call("everypage_update_file_settings", { file: FILE_UUID });
    expect(result.isError).toBe(true);
    expect(h.text(result)).toMatch(/No settings were given/);
  });

  it("re-reads the file after the empty 200 so the trio is exact", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("PUT", `/api/v1/files/${FILE_UUID}/settings`, { status: 200, body: "" }),
      route("GET", `/api/v1/files/${FILE_UUID}`, { body: fileRecord({ protected: true }) }),
    ]));

    const result = await h.call("everypage_update_file_settings", { file: FILE_UUID, passcode: "x" });

    expect((result.structuredContent as Record<string, string>).shareUrl).toBe("https://everypage.test/aB3xY9kQ2mZ7");
    expect(h.text(result)).toMatch(/Passcode required to open/);
  });

  it("maps a 410 into advice about reviving a burned link", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("PUT", `/api/v1/files/${FILE_UUID}/settings`, { status: 410, body: "This link is no longer available" }),
    ]));

    const result = await h.call("everypage_update_file_settings", { file: FILE_UUID, allowDownload: true });

    expect(result.isError).toBe(true);
    expect(h.text(result)).toMatch(/everypage_replace_content/);
  });
});

describe("everypage_delete_file", () => {
  it("trashes by default and says the deletion is reversible", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("DELETE", `/api/v1/files/${FILE_UUID}`, { status: 204, body: "" }),
    ]));

    const result = await h.call("everypage_delete_file", { file: FILE_UUID });

    expect(h.stub.requests.find((r) => r.method === "DELETE")!.query.get("purge")).toBeNull();
    expect(result.structuredContent).toMatchObject({ trashed: true, purged: false });
    expect(h.text(result)).toMatch(/moved to the trash/);
  });

  it("purges only when explicitly asked, and says it cannot be undone", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("DELETE", `/api/v1/files/${FILE_UUID}`, { status: 204, body: "" }),
    ]));

    const result = await h.call("everypage_delete_file", { file: FILE_UUID, purge: true });

    expect(h.stub.requests.find((r) => r.method === "DELETE")!.query.get("purge")).toBe("1");
    expect(result.structuredContent).toMatchObject({ trashed: false, purged: true });
    expect(h.text(result)).toMatch(/cannot be recovered/);
  });
});

describe("everypage_list_files", () => {
  it("filters by name client-side and says how many were hidden", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("GET", "/api/v1/files", {
        body: [
          fileRecord({ originalName: "Q3 proposal.pdf" }),
          fileRecord({ uuid: "other", shortId: "zzz", originalName: "invoice.pdf" }),
        ],
      }),
    ]));

    const result = await h.call("everypage_list_files", { query: "proposal" });

    expect(result.structuredContent).toMatchObject({ totalCount: 2, shown: 1 });
    expect(h.text(result)).toContain("Q3 proposal.pdf");
    expect(h.text(result)).not.toContain("invoice.pdf");
  });

  it("says so plainly when the account is empty", async () => {
    const h = (active = await harness([USER_ROUTE, route("GET", "/api/v1/files", { body: [] })]));
    const result = await h.call("everypage_list_files", {});
    expect(h.text(result)).toMatch(/no documents yet/);
  });
});

describe("everypage_get_readership", () => {
  const readershipRoute = (body: unknown) => route("GET", `/api/v1/files/${FILE_UUID}/readership`, { body });

  it("summarizes rather than dumping, and names the biggest drop-off", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      readershipRoute({
        file: fileRecord(),
        tier: "pro",
        summary: {
          totalViews: 23,
          totalSessions: 19,
          uniqueVisitors: 11,
          uniqueCountries: 4,
          avgTimeMs: 185_000,
          medianTimeMs: 160_000,
          completionRate: 62,
          downloads: 5,
        },
        funnel: [
          { page: 1, reached: 19, pct: 100 },
          { page: 6, reached: 18, pct: 95 },
          { page: 7, reached: 11, pct: 58 },
          { page: 14, reached: 8, pct: 42 },
        ],
        countries: [{ label: "United Kingdom", count: 9 }],
        variants: [{ uuid: "v1", label: "Jane at Acme", sessions: 4, avgTimeMs: 250_000, revoked: false, redacted: false }],
      }),
      route("GET", `/api/v1/files/${FILE_UUID}/readership/pages`, {
        body: { totalPages: 14, pages: [{ pageNumber: 9, views: 12, avgDurationMs: 40_000, backTurns: 11 }] },
      }),
    ]));

    const result = await h.call("everypage_get_readership", { file: FILE_UUID });
    const text = h.text(result);

    expect(text).toMatch(/biggest fall-off is at page 7/);
    expect(text).toMatch(/Most re-read page: 9/);
    expect(text).toMatch(/Average read time 3m 05s/);
    expect(text).toMatch(/62% read to the end/);
    expect(text).toMatch(/Jane at Acme/);
    // Raw rows belong in structuredContent, not in the model's context.
    expect(result.structuredContent).toMatchObject({ biggestDropPage: 7, completionRate: 62 });
  });

  it("degrades to the summary when page stats are plan-gated", async () => {
    const h = (active = await harness([
      route("GET", "/api/v1/user", { body: { subscription: "free" } }),
      readershipRoute({
        file: fileRecord(),
        tier: "free",
        summary: { totalViews: 3, totalSessions: 2, uniqueVisitors: 2, avgTimeMs: 60_000, downloads: 0 },
      }),
      route("GET", `/api/v1/files/${FILE_UUID}/readership/pages`, {
        status: 403,
        body: "This feature requires the basic plan or higher",
      }),
    ]));

    const result = await h.call("everypage_get_readership", { file: FILE_UUID });

    // A gated section is a missing paragraph, never a failed tool call.
    expect(result.isError).toBeFalsy();
    expect(h.text(result)).toMatch(/free plan/);
    expect(h.text(result)).toMatch(/2 sessions/);
  });

  it("says plainly when nobody has opened the document", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      readershipRoute({
        file: fileRecord({ viewCount: 0 }),
        tier: "pro",
        summary: { totalViews: 0, totalSessions: 0, uniqueVisitors: 0, avgTimeMs: 0, downloads: 0 },
      }),
      route("GET", `/api/v1/files/${FILE_UUID}/readership/pages`, { body: { pages: [], totalPages: 14 } }),
    ]));

    const result = await h.call("everypage_get_readership", { file: FILE_UUID });
    expect(h.text(result)).toMatch(/Nobody has opened this document yet/);
  });

  it("explains that a page range makes deep pages unreachable by design", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      readershipRoute({
        file: fileRecord(),
        tier: "basic",
        summary: { totalViews: 5, totalSessions: 5, uniqueVisitors: 5, avgTimeMs: 30_000, downloads: 0 },
        effectivePages: 3,
        funnel: [
          { page: 1, reached: 5, pct: 100 },
          { page: 3, reached: 1, pct: 20 },
        ],
      }),
      route("GET", `/api/v1/files/${FILE_UUID}/readership/pages`, { body: { pages: [], totalPages: 14 } }),
    ]));

    const result = await h.call("everypage_get_readership", { file: FILE_UUID });
    expect(h.text(result)).toMatch(/unreachable by design, not abandoned/);
  });
});

describe("everypage_list_events", () => {
  it("computes a cursor the API does not return, and warns it is per-type", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("GET", "/api/v1/events", {
        body: [
          { id: 4812, type: "view", fileName: "proposal.pdf", readAt: "2026-08-09T14:22:00Z", pagesViewed: 6, timeMs: 160_000, country: "United Kingdom" },
          { id: 4799, type: "view", fileName: "proposal.pdf", readAt: "2026-08-09T11:02:00Z", pagesViewed: 2, timeMs: 20_000 },
        ],
      }),
    ]));

    const result = await h.call("everypage_list_events", {});
    const text = h.text(result);

    expect(result.structuredContent).toMatchObject({ type: "view", nextCursor: 4812, count: 2 });
    expect(text).toMatch(/read 6 pages in 2m 40s from United Kingdom/);
    expect(text).toMatch(/not valid for the other streams/);
  });

  it("does not rewind the cursor when a poll comes back empty", async () => {
    const h = (active = await harness([USER_ROUTE, route("GET", "/api/v1/events", { body: [] })]));

    const result = await h.call("everypage_list_events", { since: 4812 });

    expect(result.structuredContent).toMatchObject({ nextCursor: 4812 });
    expect(h.text(result)).toMatch(/No new view events since cursor 4812/);
  });

  it("renders captured leads from the gate stream", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("GET", "/api/v1/events", {
        body: [
          {
            id: 91,
            type: "gate",
            fileName: "pricing.pdf",
            readAt: "2026-08-09T09:00:00Z",
            fields: { email: "jane@acme.com", company: "Acme" },
          },
        ],
      }),
    ]));

    const result = await h.call("everypage_list_events", { type: "gate" });

    expect(h.text(result)).toMatch(/lead captured: jane@acme.com \(company: Acme\)/);
  });

  it("passes the requested stream and limit through to the API", async () => {
    const h = (active = await harness([USER_ROUTE, route("GET", "/api/v1/events", { body: [] })]));

    await h.call("everypage_list_events", { type: "download", limit: 50, since: 7 });

    const req = h.stub.requests.find((r) => r.path === "/api/v1/events")!;
    expect(req.query.get("type")).toBe("download");
    expect(req.query.get("limit")).toBe("50");
    expect(req.query.get("since")).toBe("7");
  });
});

describe("everypage_create_variants", () => {
  it("mints one link per recipient from a single call", async () => {
    let created = 0;
    const h = (active = await harness([
      USER_ROUTE,
      (req) => {
        if (req.method === "POST" && req.path === `/api/v1/files/${FILE_UUID}/variants`) {
          created++;
          return {
            status: 201,
            body: {
              uuid: `v${created}`,
              shortId: `s${created}`,
              url: `https://everypage.test/s${created}`,
              label: (req.body as { label?: string }).label,
            },
          };
        }
        return undefined;
      },
    ]));

    const result = await h.call("everypage_create_variants", {
      file: FILE_UUID,
      recipients: [{ label: "Alice" }, { label: "Bob" }, { label: "Carol" }],
    });

    expect(created).toBe(3);
    expect(result.structuredContent).toMatchObject({ created: 3, failed: 0 });
    expect(h.text(result)).toContain("Alice");
    expect(h.text(result)).toContain("Carol");
    expect(h.text(result)).toMatch(/only their own link/);
  });

  it("reports per-recipient failures without losing the successes", async () => {
    let calls = 0;
    const h = (active = await harness([
      USER_ROUTE,
      (req) => {
        if (req.method !== "POST" || req.path !== `/api/v1/files/${FILE_UUID}/variants`) return undefined;
        calls++;
        return calls === 2
          ? { status: 400, body: "label too long" }
          : { status: 201, body: { uuid: "v1", shortId: "s1", url: "https://everypage.test/s1", label: "Alice" } };
      },
    ]));

    const result = await h.call("everypage_create_variants", {
      file: FILE_UUID,
      recipients: [{ label: "Alice" }, { label: "Bob" }],
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ created: 1, failed: 1 });
    expect(h.text(result)).toMatch(/Bob: label too long/);
  });
});

describe("everypage_update_variant", () => {
  it("merges onto the stored overrides instead of replacing them", async () => {
    // The API replaces `overrides` wholesale. Sending only allowDownload
    // would silently drop the recipient's page range.
    let sent: Record<string, unknown> | undefined;
    const h = (active = await harness([
      USER_ROUTE,
      route("GET", `/api/v1/files/${FILE_UUID}/variants`, {
        body: {
          variants: [
            {
              uuid: "v1",
              shortId: "s1",
              label: "Alice",
              url: "https://everypage.test/s1",
              overrides: { pageRange: { from: 2, to: 5 } },
            },
          ],
        },
      }),
      (req) => {
        if (req.method === "PUT" && req.path === `/api/v1/files/${FILE_UUID}/variants/v1`) {
          sent = req.body as Record<string, unknown>;
          return { body: { uuid: "v1", shortId: "s1", label: "Alice", url: "https://everypage.test/s1" } };
        }
        return undefined;
      },
    ]));

    await h.call("everypage_update_variant", { file: FILE_UUID, variant: "v1", allowDownload: true });

    expect(sent!.overrides).toEqual({ pageRange: { from: 2, to: 5 }, allowDownload: true });
  });

  it("accepts a recipient label as the variant reference", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("GET", `/api/v1/files/${FILE_UUID}/variants`, {
        body: { variants: [{ uuid: "v1", shortId: "s1", label: "Jane at Acme", url: "https://everypage.test/s1" }] },
      }),
      route("PUT", `/api/v1/files/${FILE_UUID}/variants/v1`, {
        body: { uuid: "v1", shortId: "s1", label: "Jane at Acme", revoked: true, url: "https://everypage.test/s1" },
      }),
    ]));

    const result = await h.call("everypage_update_variant", {
      file: FILE_UUID,
      variant: "Jane at Acme",
      revoked: true,
    });

    expect(result.isError).toBeFalsy();
    expect(h.text(result)).toMatch(/revoked - this link no longer works/);
  });

  it("refuses an ambiguous label rather than guessing", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("GET", `/api/v1/files/${FILE_UUID}/variants`, {
        body: {
          variants: [
            { uuid: "v1", label: "Jane", url: "u1" },
            { uuid: "v2", label: "Jane", url: "u2" },
          ],
        },
      }),
    ]));

    const result = await h.call("everypage_update_variant", { file: FILE_UUID, variant: "Jane", revoked: true });

    expect(result.isError).toBe(true);
    expect(h.text(result)).toMatch(/matches 2 per-recipient links/);
  });
});

describe("everypage_delete_variant", () => {
  it("reports redaction honestly - the link is NOT deleted", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("GET", `/api/v1/files/${FILE_UUID}/variants`, {
        body: { variants: [{ uuid: "v1", label: "Alice", url: "u1" }] },
      }),
      route("DELETE", `/api/v1/files/${FILE_UUID}/variants/v1`, { status: 204, body: "" }),
    ]));

    const result = await h.call("everypage_delete_variant", { file: FILE_UUID, variant: "v1", redact: true });

    expect(result.structuredContent).toMatchObject({ deleted: false, redacted: true });
    expect(h.text(result)).toMatch(/link itself still works/);
    expect(h.stub.requests.find((r) => r.method === "DELETE")!.query.get("redact")).toBe("1");
  });

  it("reports a plain delete as a delete", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("GET", `/api/v1/files/${FILE_UUID}/variants`, {
        body: { variants: [{ uuid: "v1", label: "Alice", url: "u1" }] },
      }),
      route("DELETE", `/api/v1/files/${FILE_UUID}/variants/v1`, { status: 204, body: "" }),
    ]));

    const result = await h.call("everypage_delete_variant", { file: FILE_UUID, variant: "v1" });

    expect(result.structuredContent).toMatchObject({ deleted: true, redacted: false });
    expect(h.stub.requests.find((r) => r.method === "DELETE")!.query.get("redact")).toBeNull();
  });
});

describe("webhooks and account", () => {
  it("leads with the signing secret and says it is shown once", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("POST", "/api/v1/webhooks", {
        status: 201,
        body: { webhook: { uuid: "w1", url: "https://hooks.example.com/ep" }, secret: "whsec_abc123" },
      }),
    ]));

    const result = await h.call("everypage_manage_webhook", {
      action: "create",
      url: "https://hooks.example.com/ep",
      events: ["file.viewed"],
    });

    const text = h.text(result);
    expect(text.indexOf("whsec_abc123")).toBeLessThan(text.indexOf("Endpoint"));
    expect(text).toMatch(/never show it again/);
    expect(result.structuredContent).toMatchObject({ secret: "whsec_abc123" });
  });

  it("warns that gate.completed needs Pro to ever fire", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("POST", "/api/v1/webhooks", { status: 201, body: { webhook: { uuid: "w1" }, secret: "whsec_x" } }),
    ]));

    const result = await h.call("everypage_manage_webhook", {
      action: "create",
      url: "https://hooks.example.com/ep",
      events: ["gate.completed"],
    });

    expect(h.text(result)).toMatch(/only delivers while the account is on the Pro plan/);
  });

  it("surfaces failing endpoints so a dead automation is diagnosable", async () => {
    const h = (active = await harness([
      USER_ROUTE,
      route("GET", "/api/v1/webhooks", {
        body: {
          webhooks: [
            { uuid: "w1", url: "https://a.example.com", events: ["file.viewed"], active: false, consecutiveFailures: 20 },
          ],
        },
      }),
    ]));

    const result = await h.call("everypage_list_webhooks", {});

    expect(h.text(result)).toMatch(/DISABLED/);
    expect(h.text(result)).toMatch(/disables an endpoint automatically after 20/);
  });

  it("reports the plan and what it locks", async () => {
    const h = (active = await harness([route("GET", "/api/v1/user", { body: { email: "a@b.com", subscription: "basic" } })]));

    const result = await h.call("everypage_account", {});
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured.plan).toBe("basic");
    expect(structured.maxUploadLabel).toBe("200 MiB");
    expect((structured.lockedFeatures as string[]).some((f) => f.includes("Per-recipient link"))).toBe(true);
    // Basic-tier features must NOT appear as locked.
    expect((structured.lockedFeatures as string[]).some((f) => f.startsWith("Passcode"))).toBe(false);
  });
});

describe("plan caching", () => {
  it("fetches the account at most once across many tool calls", async () => {
    const h = (active = await harness([
      routeSequence("GET", "/api/v1/user", [{ body: { subscription: "pro" } }]),
      route("GET", "/api/v1/files", { body: [] }),
    ]));

    await h.call("everypage_account", {});
    await h.call("everypage_account", {});
    await h.call("everypage_list_files", {});

    expect(h.stub.requests.filter((r) => r.path === "/api/v1/user")).toHaveLength(1);
  });
});
