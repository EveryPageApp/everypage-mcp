/**
 * Readership and events - the "who actually read this?" half of the product.
 *
 * The design constraint here is different from every other tool: the raw
 * report is big, plan-shaped, and mostly uninteresting. Dumping it would burn
 * context and leave the model to do arithmetic it is bad at. So this file
 * *computes the finding* - where readers dropped off, which page they went
 * back to - and puts the rows in structuredContent for anything that wants to
 * chart them (AUTOMATION-MATRIX.md D21).
 *
 * Every section is optional. Sections above the account's tier are ABSENT,
 * not empty, so nothing here may assume presence; `tier` explains the gaps.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { EveryPageApiError } from "../http.js";
import { bar, humanDuration, paragraphs, pct, plural, relativeTime, sample, shortTimestamp } from "../format.js";
import { resolveFile } from "../resolve.js";
import type {
  AnnotationsReport,
  EventType,
  FunnelPoint,
  PageMarksReport,
  PageReport,
  ReadEvent,
  ReadershipReport,
} from "../types.js";
import { guard, ok, type ToolContext, type ToolResult } from "./context.js";

/**
 * The steepest consecutive drop in the reach funnel.
 *
 * The funnel is "how many sessions reached page N", monotonically
 * non-increasing. The biggest single step down is where the document loses
 * people - the one number an owner actually acts on.
 */
export function steepestDrop(funnel: FunnelPoint[]): { page: number; lostPct: number } | null {
  let worst: { page: number; lostPct: number } | null = null;
  for (let i = 1; i < funnel.length; i++) {
    const previous = funnel[i - 1]!;
    const current = funnel[i]!;
    if (previous.reached <= 0) continue;
    const lostPct = ((previous.reached - current.reached) / previous.reached) * 100;
    if (lostPct > 0 && (worst === null || lostPct > worst.lostPct)) {
      worst = { page: current.page, lostPct };
    }
  }
  return worst;
}

/** Renders the funnel as a sampled sparkline that always keeps first and last. */
function funnelSparkline(funnel: FunnelPoint[]): string {
  const peak = Math.max(...funnel.map((f) => f.reached), 1);
  return sample(funnel, 8)
    .map((point) => `p${point.page} ${bar(point.reached / peak, 10)} ${point.reached}`)
    .join("   ");
}

/**
 * Renders proofing feedback as the thing the asker actually wants: which pages
 * were chosen, which were rejected, and who said so - not a row dump (D21).
 * Page numbers are listed because "pages 2, 7 and 11" is the answer to "which
 * shots did they pick?", whereas a count is not.
 */
function summarizeProofing(
  marks: PageMarksReport | undefined,
  annotations: AnnotationsReport | undefined,
): string | null {
  const lines: string[] = [];
  const totals = marks?.totals;
  const marked = (totals?.pick ?? 0) + (totals?.reject ?? 0) + (totals?.maybe ?? 0);

  if (marked > 0) {
    lines.push(
      `Proofing: ${plural(totals?.pick ?? 0, "pick")} · ${plural(totals?.reject ?? 0, "reject")} · ${totals?.maybe ?? 0} maybe`,
    );
    for (const viewer of marks?.viewers ?? []) {
      const byVerdict = (want: string) =>
        viewer.marks.filter((m) => m.mark === want).map((m) => m.page).sort((a, b) => a - b);
      const picked = byVerdict("pick");
      const rejected = byVerdict("reject");
      const maybe = byVerdict("maybe");
      const bits = [
        picked.length ? `picked ${picked.join(", ")}` : null,
        rejected.length ? `rejected ${rejected.join(", ")}` : null,
        maybe.length ? `unsure on ${maybe.join(", ")}` : null,
      ].filter(Boolean);
      if (bits.length) lines.push(`  ${viewer.identity}: ${bits.join("; ")}`);
    }
  }

  const notes = (annotations?.pages ?? []).flatMap((p) =>
    p.annotations.map((a) => ({ page: p.page, ...a })),
  );
  if (notes.length) {
    lines.push(`${plural(notes.length, "annotation")} left on the document:`);
    for (const n of notes.slice(0, 8)) {
      lines.push(`  p.${n.page} ${n.identity}${n.note ? `: "${n.note}"` : ""}`);
    }
    if (notes.length > 8) lines.push(`  …and ${notes.length - 8} more.`);
  }

  return lines.length ? lines.join("\n") : null;
}

function summarizeReadership(
  report: ReadershipReport,
  pages: PageReport | undefined,
  fileName: string,
  marks?: PageMarksReport,
  annotations?: AnnotationsReport,
): string {
  const summary = report.summary ?? {};
  const tier = report.tier ?? "free";
  const file = report.file;
  const parts: string[] = [];

  // Both facts are optional - a document whose page count has not been
  // resolved must not render "(, shared moments ago)".
  const totalPages = file?.totalPages ?? pages?.totalPages;
  const facts = [
    totalPages ? plural(totalPages, "page") : null,
    file?.createdAt ? `shared ${relativeTime(file.createdAt)}` : null,
  ].filter(Boolean);
  parts.push(`Readership for "${fileName}"${facts.length ? ` (${facts.join(", ")})` : ""} - plan: ${tier}`);

  // --- headline numbers, all free-tier ---
  const headline = [
    `${plural(summary.totalViews ?? 0, "view")}`,
    `${plural(summary.totalSessions ?? 0, "session")}`,
    `${plural(summary.uniqueVisitors ?? 0, "unique reader")}`,
  ];
  if (summary.uniqueCountries) {
    headline.push(`${summary.uniqueCountries} ${summary.uniqueCountries === 1 ? "country" : "countries"}`);
  }
  const second = [`Average read time ${humanDuration(summary.avgTimeMs)}`];
  if (summary.medianTimeMs !== undefined) second.push(`median ${humanDuration(summary.medianTimeMs)}`);
  if (summary.completionRate !== undefined) second.push(`${pct(summary.completionRate)} read to the end`);
  second.push(`${plural(summary.downloads ?? 0, "download")}`);

  parts.push(`Overall: ${headline.join(" · ")}\n${second.join(" · ")}`);

  if ((summary.totalSessions ?? 0) === 0) {
    parts.push("Nobody has opened this document yet.");
    return parts.join("\n\n");
  }

  // --- where readers stop (Basic+) ---
  if (report.funnel && report.funnel.length > 1) {
    const lines: string[] = [];
    const drop = steepestDrop(report.funnel);
    if (drop && drop.lostPct >= 10) {
      lines.push(`Page-by-page: the biggest fall-off is at page ${drop.page}, where ${pct(drop.lostPct)} of readers stop.`);
    } else {
      lines.push("Page-by-page: readers hold steady - no single page loses a large share of them.");
    }
    if (report.effectivePages !== undefined) {
      lines.push(
        `Note: a page range limits readers to ${plural(report.effectivePages, "page")}, so pages beyond that are unreachable by design, not abandoned.`,
      );
    }
    if (pages?.pages?.length) {
      const mostReread = [...pages.pages].sort((a, b) => b.backTurns - a.backTurns)[0];
      if (mostReread && mostReread.backTurns > 0) {
        lines.push(`Most re-read page: ${mostReread.pageNumber} (${plural(mostReread.backTurns, "back-turn")}).`);
      }
    }
    lines.push(`  ${funnelSparkline(report.funnel)}`);
    parts.push(lines.join("\n"));
  }

  // --- where they came from (Basic+) ---
  if (report.countries?.length) {
    const top = report.countries.slice(0, 5).map((c) => `${c.label} (${c.count})`);
    parts.push(`Countries: ${top.join(", ")}${report.countries.length > 5 ? ", …" : ""}`);
  }

  // --- proofing feedback (Pro, opt-in) ---
  const proofing = summarizeProofing(marks, annotations);
  if (proofing) parts.push(proofing);

  // --- per-recipient attribution (Pro) ---
  if (report.variants?.length) {
    const rows = [...report.variants]
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 10)
      .map((v) => {
        const label = v.redacted ? "(redacted)" : v.label || "(unlabelled)";
        const flags = [v.revoked ? "revoked" : null].filter(Boolean).join(", ");
        return `  • ${label}${flags ? ` [${flags}]` : ""} - ${plural(v.sessions, "session")}, avg ${humanDuration(v.avgTimeMs)}`;
      });
    parts.push(`Per-recipient links:\n${rows.join("\n")}`);
  }

  // --- captured leads (Pro) ---
  if (report.contacts?.length) {
    const recent = report.contacts.slice(0, 5).map((c) => {
      const identity = c.fields.email ?? Object.values(c.fields)[0] ?? "(no fields)";
      return `  • ${identity} - ${relativeTime(c.createdAt)}`;
    });
    parts.push(
      `${plural(report.contacts.length, "captured lead")} from the email gate:\n${recent.join("\n")}` +
        (report.contacts.length > 5 ? "\n  …" : ""),
    );
  }

  // --- honest about what the plan hides ---
  if (tier === "free") {
    parts.push(
      "This account is on the free plan, so page-by-page statistics, read-through rates and country breakdowns are not included.",
    );
  } else if (tier === "basic") {
    parts.push("Reader identities and per-recipient attribution need the Pro plan.");
  }

  return parts.join("\n\n");
}

export function registerReadershipTools(server: McpServer, ctx: ToolContext): void {
  // ----------------------------------------------------------- readership
  server.registerTool(
    "everypage_get_readership",
    {
      title: "Get a document's readership",
      description:
        "Find out who read an EveryPage document and how far they got: views, unique readers, read time, " +
        "completion rate, countries, where readers dropped off, and per-recipient attribution. " +
        "Use this to answer questions like \"did they read my proposal?\" or \"where do people stop reading?\".",
      inputSchema: {
        file: z.string().describe("The document: UUID, short link id, or a pasted share URL."),
        includePages: z
          .boolean()
          .optional()
          .describe("Also fetch per-page statistics to find the most re-read page. Default true. Requires the Basic plan or higher."),
        includeProofing: z
          .boolean()
          .optional()
          .describe(
            "Also fetch proofing feedback: which pages readers marked pick/reject/maybe, and the annotations they drew. " +
              "Default false - turn it on to answer \"which shots did they choose?\", \"what did the client reject?\" or " +
              "\"what feedback did they leave?\". Requires the Pro plan.",
          ),
      },
      outputSchema: {
        fileUuid: z.string(),
        fileName: z.string().optional(),
        tier: z.string().optional().describe("The plan that shaped this report; sections above it are absent."),
        totalViews: z.number().optional(),
        totalSessions: z.number().optional(),
        uniqueVisitors: z.number().optional(),
        uniqueCountries: z.number().optional(),
        avgTimeMs: z.number().optional(),
        downloads: z.number().optional(),
        medianTimeMs: z.number().optional(),
        completionRate: z.number().optional(),
        // Declared because the whole summary object is spread into the
        // result, and the client rejects any key the schema does not name.
        totalTurns: z.number().optional(),
        backTurnShare: z.number().optional(),
        activeReaders: z.number().optional(),
        newSessions: z.number().optional(),
        returningSessions: z.number().optional(),
        invitedNotViewed: z.number().optional(),
        biggestDropPage: z.number().optional().describe("The page with the steepest fall-off in readers."),
        biggestDropPct: z.number().optional(),
        funnel: z.array(z.object({}).passthrough()).optional(),
        pages: z.array(z.object({}).passthrough()).optional(),
        countries: z.array(z.object({}).passthrough()).optional(),
        variants: z.array(z.object({}).passthrough()).optional(),
        pageMarks: z.array(z.object({}).passthrough()).optional(),
        markViewers: z.array(z.object({}).passthrough()).optional(),
        markTotals: z.object({}).passthrough().optional(),
        annotations: z.array(z.object({}).passthrough()).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(ctx, { action: "reading the document's readership", scope: "readership:read" }, async ({ file: input, includePages, includeProofing }): Promise<ToolResult> => {
      const resolved = await resolveFile(ctx.http, input);
      const report = await ctx.http.json<ReadershipReport>({
        method: "GET",
        path: `/api/v1/files/${encodeURIComponent(resolved.uuid)}/readership`,
      });

      // Page stats are Basic+. Asking for them on a free account is not an
      // error - the summary is still worth returning, minus that one line.
      let pages: PageReport | undefined;
      if (includePages !== false) {
        try {
          pages = await ctx.http.json<PageReport>({
            method: "GET",
            path: `/api/v1/files/${encodeURIComponent(resolved.uuid)}/readership/pages`,
          });
        } catch (err) {
          if (!(err instanceof EveryPageApiError && err.status === 403)) throw err;
        }
      }

      // Proofing feedback is Pro and opt-in: most documents never enable page
      // marks, so fetching it by default would spend two requests per call to
      // learn nothing. Same 403-tolerance as page stats above - a plan that
      // cannot see it must not sink the whole report.
      let marks: PageMarksReport | undefined;
      let annotations: AnnotationsReport | undefined;
      if (includeProofing === true) {
        const proofing = await Promise.all(
          (["page-marks", "annotations"] as const).map(async (path) => {
            try {
              return await ctx.http.json<PageMarksReport & AnnotationsReport>({
                method: "GET",
                path: `/api/v1/files/${encodeURIComponent(resolved.uuid)}/${path}`,
              });
            } catch (err) {
              if (err instanceof EveryPageApiError && err.status === 403) return undefined;
              throw err;
            }
          }),
        );
        marks = proofing[0];
        annotations = proofing[1];
      }

      const fileName = report.file?.originalName ?? resolved.file?.originalName ?? "(unnamed)";
      const summary = report.summary ?? {};
      const drop = report.funnel ? steepestDrop(report.funnel) : null;

      return ok(summarizeReadership(report, pages, fileName, marks, annotations), {
        fileUuid: resolved.uuid,
        fileName,
        ...(report.tier !== undefined ? { tier: report.tier } : {}),
        ...summary,
        ...(drop ? { biggestDropPage: drop.page, biggestDropPct: Math.round(drop.lostPct) } : {}),
        ...(report.funnel ? { funnel: report.funnel } : {}),
        ...(pages?.pages ? { pages: pages.pages } : {}),
        ...(report.countries ? { countries: report.countries } : {}),
        ...(report.variants ? { variants: report.variants } : {}),
        ...(marks?.pages ? { pageMarks: marks.pages } : {}),
        ...(marks?.viewers ? { markViewers: marks.viewers } : {}),
        ...(marks?.totals ? { markTotals: marks.totals } : {}),
        ...(annotations?.pages ? { annotations: annotations.pages } : {}),
      });
    }),
  );

  // --------------------------------------------------------------- events
  server.registerTool(
    "everypage_list_events",
    {
      title: "List recent read activity",
      description:
        "Recent activity across the account's EveryPage documents: view sessions, downloads, or leads captured by " +
        "the email gate. Returns a cursor so a later call can fetch only what has happened since. " +
        "Use this to answer \"has anyone read anything today?\" or to poll for new reads.",
      inputSchema: {
        type: z
          .enum(["view", "download", "gate"])
          .optional()
          .describe(
            "Which stream: view sessions (default), downloads, or gate (leads captured by the email-capture form; requires the Pro plan).",
          ),
        file: z.string().optional().describe("Limit to one document: UUID, short link id, or a pasted share URL."),
        since: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Cursor from a previous call's nextCursor. Only valid for the SAME type - cursors are not comparable across streams. Omit for the most recent activity.",
          ),
        limit: z.number().int().min(1).max(100).optional().describe("How many events. Default 25, maximum 100."),
      },
      outputSchema: {
        type: z.string().describe("The stream these events came from."),
        events: z.array(z.object({}).passthrough()),
        count: z.number(),
        nextCursor: z
          .number()
          .describe("Pass as `since` on the next call, with the SAME type, to get only newer events."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(ctx, { action: "reading the events feed", scope: "readership:read" }, async ({ type, file, since, limit }): Promise<ToolResult> => {
      const streamType: EventType = type ?? "view";

      // `?file=` accepts a uuid or short id directly, so a pasted URL only
      // needs stripping, not a lookup round trip.
      let fileFilter: string | undefined;
      if (file) {
        const resolved = await resolveFile(ctx.http, file);
        fileFilter = resolved.uuid;
      }

      const events = await ctx.http.json<ReadEvent[]>({
        method: "GET",
        path: "/api/v1/events",
        query: {
          type: streamType,
          since: since ?? 0,
          limit: limit ?? 25,
          ...(fileFilter ? { file: fileFilter } : {}),
        },
      });

      // The API returns no cursor field, so it is the highest id seen. Only
      // advance on a non-empty page, or an empty poll would reset to 0 and
      // replay the whole window.
      const maxId = events.reduce((max, e) => (typeof e.id === "number" && e.id > max ? e.id : max), since ?? 0);

      if (events.length === 0) {
        return ok(
          since
            ? `No new ${streamType} events since cursor ${since}.`
            : `No ${streamType} events yet${file ? " for that document" : ""}.`,
          { type: streamType, events: [], count: 0, nextCursor: since ?? 0 },
        );
      }

      const lines = events.map((event) => {
        const name = event.fileName ?? event.fileUuid ?? "(unknown document)";
        const when = shortTimestamp(event.readAt);
        const where = event.country ? ` from ${event.country}` : "";
        switch (streamType) {
          case "download":
            return `• ${name} - downloaded${where}, ${when}`;
          case "gate": {
            const fields = event.fields ?? {};
            const identity = fields.email ?? Object.values(fields)[0] ?? "(no fields)";
            const rest = Object.entries(fields)
              .filter(([key]) => key !== "email")
              .map(([key, value]) => `${key}: ${value}`);
            return `• ${name} - lead captured: ${identity}${rest.length ? ` (${rest.join(", ")})` : ""}, ${when}`;
          }
          default: {
            const pagesRead = event.pagesViewed ?? 0;
            const duration = humanDuration(event.timeMs);
            return `• ${name} - read ${plural(pagesRead, "page")} in ${duration}${where}, ${when}`;
          }
        }
      });

      const ordering = since ? "oldest first, from your cursor" : "newest first";
      return ok(
        paragraphs(
          `${plural(events.length, `${streamType} event`)} (${ordering}):`,
          lines.join("\n"),
          `Next cursor: ${maxId} - pass it as \`since\` with type "${streamType}" to get only newer events. ` +
            "It is not valid for the other streams.",
        ),
        { type: streamType, events, count: events.length, nextCursor: maxId },
      );
    }),
  );
}
