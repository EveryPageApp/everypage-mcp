/**
 * Document tools: share, list, get, configure, delete, replace.
 *
 * `everypage_share_pdf` is the headline. "Share this PDF and give me a
 * tracked link" is one intent, so it is one call - upload plus settings plus
 * the share trio - rather than three the model has to sequence correctly.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ToolInputError, warningText } from "../errors.js";
import { humanBytes, markdownTable, paragraphs, plural, relativeTime } from "../format.js";
import { sourceFromPath, sourceFromUrl, uploadForm, type PdfSource } from "../pdf.js";
import { resolveFile } from "../resolve.js";
import { preferredId, shareTrio } from "../share-url.js";
import type { EveryPageFile, UploadResult } from "../types.js";
import { guard, ok, trioSchema, warningsSchema, type ToolContext, type ToolResult } from "./context.js";
import { buildSettingsPayload, settingsSchema, updateOnlySchema, type SettingsInput } from "./settings.js";

/** Fetches the canonical record so the trio is exact. */
async function getFile(ctx: ToolContext, uuid: string): Promise<EveryPageFile> {
  return ctx.http.json<EveryPageFile>({ method: "GET", path: `/api/v1/files/${encodeURIComponent(uuid)}` });
}

function trioFor(ctx: ToolContext, file: { uuid: string; shortId?: string | undefined; originalName?: string | undefined }) {
  return {
    uuid: file.uuid,
    shortId: file.shortId,
    fileName: file.originalName,
    ...shareTrio(ctx.baseUrl, file),
  };
}

/** One-line description of how a document is protected, for `get_file`. */
function protectionLines(file: EveryPageFile): string[] {
  const lines: string[] = [];
  if (file.protected) lines.push("Passcode required to open.");
  if (file.requireEmail) lines.push("Readers must give an email address before reading.");
  if (file.pageRange) lines.push(`Readers see pages ${file.pageRange.from}-${file.pageRange.to} only.`);
  if (file.allowDownload === false) lines.push("Downloads are blocked.");
  else if (file.allowDownload) lines.push("Readers may download the PDF.");
  if (file.notifyOnView) lines.push("The owner is emailed on each read.");
  if (file.deleteAt === null || file.deleteAt === undefined) lines.push("Never expires.");
  else lines.push(`Expires ${relativeTime(file.deleteAt)}.`);
  if (lines.length === 0) lines.push("No restrictions - anyone with the link can read it.");
  return lines;
}

/**
 * Applies settings after a successful upload.
 *
 * Failure here is deliberately NOT fatal: the document is already live and
 * shareable, and throwing away a completed upload because a Pro-only toggle
 * was refused would be the worst possible outcome. The caller gets the link
 * plus a warning saying exactly what did not apply.
 */
async function applySettingsAfterUpload(
  ctx: ToolContext,
  uuid: string,
  settings: SettingsInput,
): Promise<{ applied: string[]; warnings: string[] }> {
  const { payload, applied } = buildSettingsPayload(settings);
  if (Object.keys(payload).length === 0) return { applied: [], warnings: [] };

  try {
    await ctx.http.empty({
      method: "PUT",
      path: `/api/v1/files/${encodeURIComponent(uuid)}/settings`,
      jsonBody: payload,
    });
    return { applied, warnings: [] };
  } catch (err) {
    return {
      applied: [],
      warnings: [
        `The document uploaded and is live, but its settings could not be applied: ${warningText(err)}. ` +
          "The link currently has default settings.",
      ],
    };
  }
}

export function registerFileTools(server: McpServer, ctx: ToolContext): void {
  const readOnly = ctx.config.readOnly;

  // ---------------------------------------------------------------- share
  if (!readOnly) {
    server.registerTool(
      "everypage_share_pdf",
      {
        title: "Share a PDF",
        description:
          "Upload a PDF to EveryPage and get back a tracked share link, an embeddable iframe, and a QR code URL. " +
          "Give either `path` (a PDF on this machine) or `url` (an https link to a PDF). " +
          "Share settings such as a passcode, expiry or download permission can be applied in the same call. " +
          "Every read of the resulting link is tracked - use everypage_get_readership afterwards to see who read it.",
        inputSchema: {
          path: z.string().optional().describe("Absolute path to a PDF on this machine, e.g. /Users/you/proposal.pdf."),
          url: z.string().optional().describe("https:// link to a PDF. Fetched without credentials, then uploaded."),
          filename: z
            .string()
            .optional()
            .describe("Display name for the document. Defaults to the file's own name."),
          ...settingsSchema,
        },
        outputSchema: {
          ...trioSchema,
          size: z.number().optional().describe("Size of the uploaded PDF in bytes."),
          totalPages: z.number().optional(),
          appliedSettings: z.array(z.string()).optional().describe("Settings that were applied."),
          warnings: warningsSchema,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      guard(ctx, { action: "uploading the PDF" }, async (args): Promise<ToolResult> => {
        const { path, url, filename, ...settings } = args as {
          path?: string;
          url?: string;
          filename?: string;
        } & SettingsInput;

        if (!path && !url) {
          throw new ToolInputError(
            "Give either `path` (a PDF on this machine) or `url` (an https link to a PDF).",
          );
        }
        if (path && url) {
          throw new ToolInputError("Give `path` or `url`, not both.");
        }

        const { plan, caps } = await ctx.plans.caps();
        const sourceOptions = {
          maxBytes: caps.maxUploadBytes,
          maxBytesLabel: caps.maxUploadLabel,
          plan,
          filename,
          fetchFn: ctx.plainFetch,
        };

        let source: PdfSource;
        if (path) source = await sourceFromPath(path, sourceOptions);
        else source = await sourceFromUrl(url!, sourceOptions);

        let uploaded: UploadResult;
        try {
          uploaded = await ctx.http.json<UploadResult>({
            method: "POST",
            path: "/api/v1/files",
            formBody: uploadForm(source),
          });
        } finally {
          await source.cleanup();
        }

        const { applied, warnings } = await applySettingsAfterUpload(ctx, uploaded.uuid, settings);

        // Re-GET so totalPages and any server-side adjustment are real rather
        // than assumed. A failure here must not lose the link, so it degrades
        // to what the upload already told us.
        let file: EveryPageFile | undefined;
        try {
          file = await getFile(ctx, uploaded.uuid);
        } catch {
          file = undefined;
        }

        const trio = trioFor(ctx, {
          uuid: uploaded.uuid,
          shortId: file?.shortId ?? uploaded.shortId,
          originalName: file?.originalName ?? source.filename,
        });

        const pageNote = file?.totalPages ? `${plural(file.totalPages, "page")}, ` : "";
        const text = paragraphs(
          `Uploaded "${trio.fileName}" (${pageNote}${humanBytes(source.size)}).`,
          [
            `Share link: ${trio.shareUrl}`,
            `QR code:    ${trio.qr_url}`,
            `Embed:      ${trio.embed_code}`,
          ].join("\n"),
          applied.length ? `Settings applied: ${applied.join(", ")}.` : "",
          warnings.length ? warnings.join("\n") : "",
        );

        return ok(text, {
          ...trio,
          size: source.size,
          ...(file?.totalPages !== undefined ? { totalPages: file.totalPages } : {}),
          ...(applied.length ? { appliedSettings: applied } : {}),
          ...(warnings.length ? { warnings } : {}),
        });
      }),
    );
  }

  // ----------------------------------------------------------------- list
  server.registerTool(
    "everypage_list_files",
    {
      title: "List documents",
      description:
        "List the EveryPage documents on this account, newest first, with their share links and view counts. " +
        "Use `query` to filter by name when looking for a particular document.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive substring of the document name."),
        limit: z.number().int().min(1).max(200).optional().describe("How many to return. Default 20."),
      },
      outputSchema: {
        files: z.array(z.object({}).passthrough()).describe("Matching documents, newest first."),
        totalCount: z.number().describe("How many documents the account has in total."),
        shown: z.number().describe("How many are in this response."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(ctx, { action: "listing documents" }, async ({ query, limit }): Promise<ToolResult> => {
      const all = await ctx.http.json<EveryPageFile[]>({ method: "GET", path: "/api/v1/files" });

      // The endpoint is unpaginated, so filtering and limiting happen here -
      // same as the Zapier search and the Make list module.
      const needle = query?.trim().toLowerCase();
      const matched = needle
        ? all.filter((f) => (f.originalName ?? "").toLowerCase().includes(needle))
        : all;
      const shown = matched.slice(0, limit ?? 20);

      if (shown.length === 0) {
        return ok(
          needle
            ? `No documents match "${query}". The account has ${plural(all.length, "document")} in total.`
            : "This account has no documents yet. Use everypage_share_pdf to add one.",
          { files: [], totalCount: all.length, shown: 0 },
        );
      }

      const rows = shown.map((f) => [
        f.originalName ?? "(unnamed)",
        preferredId(f),
        f.viewCount ?? 0,
        f.totalPages ?? "?",
        relativeTime(f.createdAt),
        f.deleteAt ? relativeTime(f.deleteAt) : "never",
      ]);

      const header =
        matched.length > shown.length
          ? `Showing ${shown.length} of ${matched.length} matching documents (${all.length} on the account).`
          : `${plural(shown.length, "document")}${needle ? ` matching "${query}"` : ""}.`;

      return ok(
        paragraphs(
          header,
          markdownTable(["Name", "Link id", "Views", "Pages", "Created", "Expires"], rows),
          `Share links are ${ctx.baseUrl}/<link id>.`,
        ),
        {
          files: shown.map((f) => ({ ...f, ...trioFor(ctx, f) })),
          totalCount: all.length,
          shown: shown.length,
        },
      );
    }),
  );

  // ------------------------------------------------------------------ get
  server.registerTool(
    "everypage_get_file",
    {
      title: "Get a document",
      description:
        "Look up one EveryPage document and report its share links, how it is protected, and whether it is still live. " +
        "Accepts a UUID, a short link id, or a share URL pasted straight from the browser.",
      inputSchema: {
        file: z
          .string()
          .describe("The document: its UUID, its short link id, or a full share URL (e.g. https://everypage.co/aB3xY9kQ2mZ7)."),
      },
      outputSchema: { ...trioSchema, file: z.object({}).passthrough().describe("The full document record.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(ctx, { action: "looking up the document" }, async ({ file: input }): Promise<ToolResult> => {
      const resolved = await resolveFile(ctx.http, input);
      const file = resolved.file ?? (await getFile(ctx, resolved.uuid));
      const trio = trioFor(ctx, file);

      // The page count is resolved after upload and can legitimately be
      // unknown; "0 pages" would read as an empty document.
      const sizeParts = [
        file.totalPages ? plural(file.totalPages, "page") : null,
        humanBytes(file.size),
      ].filter(Boolean);

      const text = paragraphs(
        `"${file.originalName ?? "(unnamed)"}" - ${sizeParts.join(", ")}, ` +
          `uploaded ${relativeTime(file.createdAt)}. ${file.viewCount ?? 0} views so far.`,
        protectionLines(file).map((l) => `- ${l}`).join("\n"),
        [
          `Share link: ${trio.shareUrl}`,
          `QR code:    ${trio.qr_url}`,
          `Embed:      ${trio.embed_code}`,
        ].join("\n"),
      );

      return ok(text, { ...trio, file });
    }),
  );

  // ------------------------------------------------------------- settings
  if (!readOnly) {
    server.registerTool(
      "everypage_update_file_settings",
      {
        title: "Change a document's share settings",
        description:
          "Change how an existing EveryPage document is shared: passcode, expiry, downloads, viewer mode, " +
          "email gate, view limit, page range or vanity slug. Settings that are not mentioned keep their current value.",
        inputSchema: {
          file: z.string().describe("The document: UUID, short link id, or a pasted share URL."),
          ...settingsSchema,
          ...updateOnlySchema,
        },
        outputSchema: {
          ...trioSchema,
          appliedSettings: z.array(z.string()).describe("What changed."),
          file: z.object({}).passthrough().describe("The document record after the change."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      guard(ctx, { action: "updating the document's settings" }, async (args): Promise<ToolResult> => {
        const { file: input, ...settings } = args as { file: string } & SettingsInput & { clearPasscode?: boolean };
        const { payload, applied } = buildSettingsPayload(settings);

        if (Object.keys(payload).length === 0) {
          throw new ToolInputError(
            "No settings were given, so there is nothing to change. Pass at least one setting, " +
              "e.g. passcode, expiryHours, allowDownload or viewerMode.",
          );
        }

        const resolved = await resolveFile(ctx.http, input);
        await ctx.http.empty({
          method: "PUT",
          path: `/api/v1/files/${encodeURIComponent(resolved.uuid)}/settings`,
          jsonBody: payload,
        });

        // The PUT answers an empty 200, so re-GET for an exact trio and to
        // report the real post-change state (AUTOMATION-MATRIX.md §1).
        const file = await getFile(ctx, resolved.uuid);
        const trio = trioFor(ctx, file);

        return ok(
          paragraphs(
            `Updated "${file.originalName ?? "(unnamed)"}": ${applied.join(", ")}.`,
            protectionLines(file).map((l) => `- ${l}`).join("\n"),
            `Share link: ${trio.shareUrl}`,
          ),
          { ...trio, appliedSettings: applied, file },
        );
      }),
    );
  }

  // --------------------------------------------------------------- delete
  if (!readOnly) {
    server.registerTool(
      "everypage_delete_file",
      {
        title: "Delete a document",
        description:
          "Move an EveryPage document to the trash so its share link stops working. " +
          "Trashed documents can be restored from the EveryPage dashboard. " +
          "Set purge to true to destroy it permanently instead - that cannot be undone.",
        inputSchema: {
          file: z.string().describe("The document: UUID, short link id, or a pasted share URL."),
          purge: z
            .boolean()
            .optional()
            .describe("Destroy permanently instead of trashing. Irreversible - confirm with the user first."),
        },
        outputSchema: {
          uuid: z.string(),
          trashed: z.boolean().describe("True when the document went to the trash and can still be restored."),
          purged: z.boolean().describe("True when the document was destroyed permanently."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      guard(ctx, { action: "deleting the document" }, async ({ file: input, purge }): Promise<ToolResult> => {
        const resolved = await resolveFile(ctx.http, input);
        const name = resolved.file?.originalName;

        await ctx.http.empty({
          method: "DELETE",
          path: `/api/v1/files/${encodeURIComponent(resolved.uuid)}`,
          query: purge ? { purge: 1 } : {},
        });

        const label = name ? `"${name}"` : "That document";
        const text = purge
          ? `${label} has been permanently deleted. Its share link, QR code and readership history are gone and cannot be recovered.`
          : `${label} has been moved to the trash - its share link no longer works. ` +
            "It can be restored from the EveryPage dashboard, or deleted permanently by calling this tool again with purge set to true.";

        return ok(text, { uuid: resolved.uuid, trashed: !purge, purged: Boolean(purge) });
      }),
    );
  }

  // -------------------------------------------------------------- replace
  if (!readOnly) {
    server.registerTool(
      "everypage_replace_content",
      {
        title: "Replace a document's content",
        description:
          "Swap the PDF behind an existing EveryPage link, keeping the same share link, QR code, settings and " +
          "readership history - only the bytes change. Anyone who already has the link sees the new version. " +
          "This is also the way to revive a link that was burned by its view limit. " +
          "The previous version is not recoverable. Requires the Pro plan.",
        inputSchema: {
          file: z.string().describe("The document to update: UUID, short link id, or a pasted share URL."),
          path: z.string().optional().describe("Absolute path to the replacement PDF on this machine."),
          url: z.string().optional().describe("https:// link to the replacement PDF."),
          keepAnchors: z
            .boolean()
            .optional()
            .describe(
              "Keep page-anchored hotspots and reader notes despite the page numbers changing. Default false (they are cleared).",
            ),
        },
        outputSchema: {
          ...trioSchema,
          contentVersion: z.number().optional().describe("Increments on every replacement; 1 was the original upload."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      guard(ctx, { action: "replacing the document's content" }, async ({ file: input, path, url, keepAnchors }): Promise<ToolResult> => {
        if (!path && !url) {
          throw new ToolInputError("Give either `path` or `url` for the replacement PDF.");
        }
        if (path && url) {
          throw new ToolInputError("Give `path` or `url`, not both.");
        }

        const resolved = await resolveFile(ctx.http, input);
        const { plan, caps } = await ctx.plans.caps();
        const sourceOptions = {
          maxBytes: caps.maxUploadBytes,
          maxBytesLabel: caps.maxUploadLabel,
          plan,
          fetchFn: ctx.plainFetch,
        };

        const source = path
          ? await sourceFromPath(path, sourceOptions)
          : await sourceFromUrl(url!, sourceOptions);

        try {
          await ctx.http.empty({
            method: "POST",
            path: `/api/v1/files/${encodeURIComponent(resolved.uuid)}/content`,
            query: keepAnchors ? { clearAnchors: "false" } : {},
            formBody: uploadForm(source),
          });
        } finally {
          await source.cleanup();
        }

        const file = await getFile(ctx, resolved.uuid);
        const trio = trioFor(ctx, file);

        return ok(
          paragraphs(
            `Replaced the contents of "${file.originalName ?? "(unnamed)"}" ` +
              `(now ${plural(file.totalPages ?? 0, "page")}, ${humanBytes(file.size)}).` +
              (file.contentVersion ? ` This is version ${file.contentVersion}.` : ""),
            `The share link is unchanged - everyone who already has it now sees the new document: ${trio.shareUrl}`,
            keepAnchors
              ? "Page-anchored hotspots and notes were kept."
              : "Page-anchored hotspots and notes were cleared, since the page numbering may have changed.",
          ),
          { ...trio, ...(file.contentVersion !== undefined ? { contentVersion: file.contentVersion } : {}) },
        );
      }),
    );
  }
}
