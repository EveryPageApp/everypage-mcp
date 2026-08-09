/**
 * Link variants - one tracked child link per recipient, so reads are
 * attributed to a person rather than to "someone with the link".
 *
 * Two things this file hides from the model on purpose:
 *
 *  - **Creation is batched.** "Send this to Alice, Bob and Carol" is one
 *    intent; three tool calls invites the model to stop after one
 *    (AUTOMATION-MATRIX.md D23).
 *  - **`overrides` is a whole-object replace, not a merge.** Sending
 *    `{allowDownload: true}` to a variant that had a page range silently
 *    drops the page range. `update_variant` therefore reads the current
 *    overrides and merges before writing, so the model never meets that edge.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ToolInputError, warningText } from "../errors.js";
import { markdownTable, paragraphs, plural, relativeTime } from "../format.js";
import { extractIdentifier, isUuid, resolveFile } from "../resolve.js";
import type { Variant, VariantOverrides } from "../types.js";
import { guard, ok, type ToolContext, type ToolResult } from "./context.js";

const overrideSchema = {
  allowDownload: z
    .boolean()
    .optional()
    .describe("Override the document's download permission for this recipient only."),
  pageFrom: z.number().int().min(0).optional().describe("First page this recipient may see (1-based)."),
  pageTo: z.number().int().min(0).optional().describe("Last page this recipient may see."),
};

type OverrideInput = { allowDownload?: boolean; pageFrom?: number; pageTo?: number };

/** Only emits keys the caller set - an empty object clears every override. */
function buildOverrides(input: OverrideInput, base: VariantOverrides = {}): VariantOverrides | undefined {
  const merged: VariantOverrides = { ...base };
  let touched = false;

  if (input.allowDownload !== undefined) {
    merged.allowDownload = input.allowDownload;
    touched = true;
  }
  if (input.pageFrom !== undefined || input.pageTo !== undefined) {
    const from = input.pageFrom ?? base.pageRange?.from ?? 0;
    const to = input.pageTo ?? base.pageRange?.to ?? 0;
    if (from === 0 && to === 0) delete merged.pageRange;
    else merged.pageRange = { from, to };
    touched = true;
  }

  return touched ? merged : undefined;
}

/** Variants are addressed by uuid; accept a short id or pasted link too. */
async function resolveVariant(ctx: ToolContext, fileUuid: string, input: string): Promise<Variant> {
  const id = extractIdentifier(input);
  const { variants } = await ctx.http.json<{ variants?: Variant[] }>({
    method: "GET",
    path: `/api/v1/files/${encodeURIComponent(fileUuid)}/variants`,
  });
  const all = variants ?? [];

  const match = all.find((v) => v.uuid === id || v.shortId === id);
  if (match) return match;

  if (isUuid(id)) {
    throw new ToolInputError(
      `No variant with id ${id} exists on that document. Call everypage_list_variants to see its per-recipient links.`,
    );
  }
  // A label is the natural thing for a model to reach for, so accept one -
  // but only when it is unambiguous.
  const byLabel = all.filter((v) => (v.label ?? "").toLowerCase() === id.toLowerCase());
  if (byLabel.length === 1) return byLabel[0]!;
  if (byLabel.length > 1) {
    throw new ToolInputError(
      `"${id}" matches ${byLabel.length} per-recipient links on that document. Use the variant's id instead - everypage_list_variants shows them.`,
    );
  }
  throw new ToolInputError(
    `No per-recipient link matching "${input}" on that document. Call everypage_list_variants to see what exists.`,
  );
}

function variantUrl(ctx: ToolContext, variant: Variant): string {
  // The server builds `url` already (and honours a custom domain); fall back
  // to the short id only if it is missing.
  return variant.url ?? `${ctx.baseUrl}/${variant.shortId ?? variant.uuid}`;
}

export function registerVariantTools(server: McpServer, ctx: ToolContext): void {
  const readOnly = ctx.config.readOnly;

  // --------------------------------------------------------------- create
  if (!readOnly) {
    server.registerTool(
      "everypage_create_variants",
      {
        title: "Create per-recipient links",
        description:
          "Mint one tracked link per recipient for a document, so each person's reads are attributed to them by name " +
          "instead of blending into one anonymous total. Pass every recipient in a single call. " +
          "Each link can also override the document's download permission or page range for that person. Requires the Pro plan.",
        inputSchema: {
          file: z.string().describe("The document: UUID, short link id, or a pasted share URL."),
          recipients: z
            .array(
              z.object({
                label: z
                  .string()
                  .max(200)
                  .optional()
                  .describe("Who this link is for, e.g. \"Jane at Acme\". Shown only to the document's owner."),
                ...overrideSchema,
              }),
            )
            .min(1)
            .max(50)
            .describe("One entry per recipient."),
        },
        outputSchema: {
          fileUuid: z.string(),
          variants: z.array(z.object({}).passthrough()).describe("The links created, in the order requested."),
          created: z.number(),
          failed: z.number(),
          warnings: z.array(z.string()).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      guard(ctx, { action: "creating per-recipient links", scope: "files:write" }, async ({ file: input, recipients }): Promise<ToolResult> => {
        const resolved = await resolveFile(ctx.http, input);
        const created: Variant[] = [];
        const warnings: string[] = [];

        // Sequential, not parallel: the API is rate-limited per key, and a
        // burst of 50 would spend the budget the caller's next tool needs.
        for (const recipient of recipients) {
          const overrides = buildOverrides(recipient);
          try {
            const variant = await ctx.http.json<Variant>({
              method: "POST",
              path: `/api/v1/files/${encodeURIComponent(resolved.uuid)}/variants`,
              jsonBody: {
                ...(recipient.label !== undefined ? { label: recipient.label } : {}),
                ...(overrides ? { overrides } : {}),
              },
            });
            created.push(variant);
          } catch (err) {
            warnings.push(`${recipient.label ?? "(unlabelled)"}: ${warningText(err)}`);
          }
        }

        if (created.length === 0) {
          throw new ToolInputError(
            `No per-recipient links could be created. ${warnings.join(" ")}`,
          );
        }

        const rows = created.map((v) => [v.label ?? "(unlabelled)", variantUrl(ctx, v)]);
        return ok(
          paragraphs(
            `Created ${plural(created.length, "per-recipient link")} for "${resolved.file?.originalName ?? "the document"}".`,
            markdownTable(["Recipient", "Their link"], rows),
            "Send each person only their own link - reads through it are attributed to them.",
            warnings.length ? `Could not create:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "",
          ),
          {
            fileUuid: resolved.uuid,
            variants: created,
            created: created.length,
            failed: warnings.length,
            ...(warnings.length ? { warnings } : {}),
          },
        );
      }),
    );
  }

  // ----------------------------------------------------------------- list
  server.registerTool(
    "everypage_list_variants",
    {
      title: "List per-recipient links",
      description:
        "List a document's per-recipient links with their recipient labels, URLs, and whether they have been " +
        "revoked or GDPR-redacted. Requires the Pro plan.",
      inputSchema: { file: z.string().describe("The document: UUID, short link id, or a pasted share URL.") },
      outputSchema: {
        fileUuid: z.string(),
        variants: z.array(z.object({}).passthrough()),
        count: z.number(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(ctx, { action: "listing per-recipient links", scope: "files:read" }, async ({ file: input }): Promise<ToolResult> => {
      const resolved = await resolveFile(ctx.http, input);
      const { variants } = await ctx.http.json<{ variants?: Variant[] }>({
        method: "GET",
        path: `/api/v1/files/${encodeURIComponent(resolved.uuid)}/variants`,
      });
      const all = variants ?? [];

      if (all.length === 0) {
        return ok(
          "That document has no per-recipient links yet. Use everypage_create_variants to mint one per person.",
          { fileUuid: resolved.uuid, variants: [], count: 0 },
        );
      }

      const rows = all.map((v) => [
        v.redactedAt ? "(redacted)" : v.label ?? "(unlabelled)",
        variantUrl(ctx, v),
        v.revoked ? "revoked" : "active",
        relativeTime(v.createdAt),
      ]);

      return ok(
        paragraphs(
          `${plural(all.length, "per-recipient link")} on "${resolved.file?.originalName ?? "the document"}".`,
          markdownTable(["Recipient", "Link", "Status", "Created"], rows),
          all.some((v) => v.redactedAt)
            ? "Redacted links still work and still record readership - only the recipient's name was erased, permanently."
            : "",
        ),
        { fileUuid: resolved.uuid, variants: all, count: all.length },
      );
    }),
  );

  // --------------------------------------------------------------- update
  if (!readOnly) {
    server.registerTool(
      "everypage_update_variant",
      {
        title: "Update a per-recipient link",
        description:
          "Rename, revoke or restore a per-recipient link, or change what that one recipient may do. " +
          "Revoking makes their link stop working while leaving everyone else's alone; it can be undone. " +
          "Requires the Pro plan.",
        inputSchema: {
          file: z.string().describe("The document the link belongs to: UUID, short link id, or a pasted share URL."),
          variant: z.string().describe("The per-recipient link: its id, its short link id, or its exact recipient label."),
          label: z.string().max(200).optional().describe("New recipient name. An empty string clears it."),
          revoked: z.boolean().optional().describe("True stops this recipient's link working; false restores it."),
          ...overrideSchema,
        },
        outputSchema: { fileUuid: z.string(), variant: z.object({}).passthrough(), url: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      guard(ctx, { action: "updating the per-recipient link", scope: "files:write" }, async (args): Promise<ToolResult> => {
        const { file: input, variant: variantRef, label, revoked, ...overrideArgs } = args as {
          file: string;
          variant: string;
          label?: string;
          revoked?: boolean;
        } & OverrideInput;

        const resolved = await resolveFile(ctx.http, input);
        const current = await resolveVariant(ctx, resolved.uuid, variantRef);

        // Merge onto the STORED overrides: the API replaces the object
        // wholesale, so anything omitted here would be silently dropped.
        const overrides = buildOverrides(overrideArgs, current.overrides ?? {});

        const body: Record<string, unknown> = {};
        if (label !== undefined) body.label = label;
        if (revoked !== undefined) body.revoked = revoked;
        if (overrides !== undefined) body.overrides = overrides;

        if (Object.keys(body).length === 0) {
          throw new ToolInputError(
            "Nothing to change. Pass at least one of label, revoked, allowDownload, pageFrom or pageTo.",
          );
        }

        const updated = await ctx.http.json<Variant>({
          method: "PUT",
          path: `/api/v1/files/${encodeURIComponent(resolved.uuid)}/variants/${encodeURIComponent(current.uuid)}`,
          jsonBody: body,
        });

        const changes: string[] = [];
        if (label !== undefined) changes.push(label === "" ? "recipient name cleared" : `renamed to "${label}"`);
        if (revoked === true) changes.push("revoked - this link no longer works");
        if (revoked === false) changes.push("restored - this link works again");
        if (overrides !== undefined) changes.push("per-recipient permissions updated");

        return ok(
          paragraphs(
            `Updated the link for ${updated.label ?? "(unlabelled)"}: ${changes.join(", ")}.`,
            `Their link: ${variantUrl(ctx, updated)}`,
          ),
          { fileUuid: resolved.uuid, variant: updated, url: variantUrl(ctx, updated) },
        );
      }),
    );
  }

  // --------------------------------------------------------------- delete
  if (!readOnly) {
    server.registerTool(
      "everypage_delete_variant",
      {
        title: "Delete or redact a per-recipient link",
        description:
          "Permanently delete a per-recipient link, or - with redact - erase the recipient's name everywhere " +
          "while leaving the link working and the readership intact. Redaction is the right answer to a GDPR " +
          "erasure request; a redacted name can never be set again. Both are irreversible. Requires the Pro plan.",
        inputSchema: {
          file: z.string().describe("The document the link belongs to: UUID, short link id, or a pasted share URL."),
          variant: z.string().describe("The per-recipient link: its id, its short link id, or its exact recipient label."),
          redact: z
            .boolean()
            .optional()
            .describe("Erase the recipient's name instead of deleting the link. The link keeps working."),
        },
        outputSchema: {
          fileUuid: z.string(),
          variantUuid: z.string(),
          deleted: z.boolean(),
          redacted: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      guard(ctx, { action: "deleting the per-recipient link", scope: "files:write" }, async ({ file: input, variant: variantRef, redact }): Promise<ToolResult> => {
        const resolved = await resolveFile(ctx.http, input);
        const current = await resolveVariant(ctx, resolved.uuid, variantRef);
        const name = current.label ?? "(unlabelled)";

        await ctx.http.empty({
          method: "DELETE",
          path: `/api/v1/files/${encodeURIComponent(resolved.uuid)}/variants/${encodeURIComponent(current.uuid)}`,
          query: redact ? { redact: 1 } : {},
        });

        // Say what actually happened. `?redact=1` does NOT remove the variant
        // - claiming otherwise misled users on two other platforms already
        // (AUTOMATION-MATRIX.md §4.2).
        const text = redact
          ? `Redacted the per-recipient link for ${name}. Their name has been erased from the link, from the readership ` +
            "reports, and from any stored webhook payloads. The link itself still works and its readership is intact. " +
            "The name cannot be set again."
          : `Deleted the per-recipient link for ${name}. That link no longer works. Sessions recorded through it survive, ` +
            "but are no longer attributed to anyone.";

        return ok(text, {
          fileUuid: resolved.uuid,
          variantUuid: current.uuid,
          deleted: !redact,
          redacted: Boolean(redact),
        });
      }),
    );
  }
}
