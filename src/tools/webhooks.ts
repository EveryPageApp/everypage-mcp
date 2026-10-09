/**
 * Webhook endpoints and the account summary.
 *
 * A stdio MCP server cannot receive a webhook - it has no inbound HTTP
 * (AUTOMATION-MATRIX.md D19). These tools exist so an agent can wire up and
 * diagnose deliveries to *other* systems: a Slack channel, a Zap, a customer's
 * own endpoint. `list_webhooks` reporting `consecutiveFailures` is what makes
 * "why did my Zap stop firing?" answerable.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ToolInputError } from "../errors.js";
import { markdownTable, paragraphs, plural, relativeTime } from "../format.js";
import { resolveFile } from "../resolve.js";
import { FEATURE_TIERS, PLAN_CAPS, normalizePlan } from "../plan.js";
import type { Webhook, WebhookCreateResult, WebhookTestResult } from "../types.js";
import { guard, ok, type ToolContext, type ToolResult } from "./context.js";

const EVENT_KINDS = [
  "file.opened",
  "file.viewed",
  "file.downloaded",
  "gate.completed",
  "note.created",
  "receipt.confirmed",
  "file.burned",
  "content.replaced",
  "invite.viewed",
  "proofing.updated",
] as const;

export function registerWebhookTools(server: McpServer, ctx: ToolContext): void {
  const readOnly = ctx.config.readOnly;

  // ----------------------------------------------------------------- list
  server.registerTool(
    "everypage_list_webhooks",
    {
      title: "List webhook endpoints",
      description:
        "List the account's webhook endpoints, what events each receives, and whether deliveries are healthy. " +
        "Signing secrets are never retrievable - they are shown once, when the endpoint is created. " +
        "Use this to diagnose an automation that has stopped firing.",
      inputSchema: {},
      outputSchema: { webhooks: z.array(z.object({}).passthrough()), count: z.number() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(ctx, { action: "listing webhooks", scope: "webhooks:manage" }, async (): Promise<ToolResult> => {
      const { webhooks } = await ctx.http.json<{ webhooks?: Webhook[] }>({
        method: "GET",
        path: "/api/v1/webhooks",
      });
      const all = webhooks ?? [];

      if (all.length === 0) {
        return ok(
          "This account has no webhook endpoints. Use everypage_manage_webhook to add one.",
          { webhooks: [], count: 0 },
        );
      }

      const rows = all.map((w) => [
        w.url ?? "(no url)",
        (w.events ?? []).join(", ") || "(none)",
        w.fileUuid ? "one document" : "whole account",
        w.active === false ? "DISABLED" : "active",
        w.consecutiveFailures ?? 0,
      ]);

      const broken = all.filter((w) => w.active === false || (w.consecutiveFailures ?? 0) > 0);
      const health = broken.length
        ? `${plural(broken.length, "endpoint")} ${broken.length === 1 ? "is" : "are"} failing. ` +
          "EveryPage disables an endpoint automatically after 20 consecutive failures - a disabled one must be " +
          "deleted and recreated once the receiving end is fixed."
        : "All endpoints are delivering successfully.";

      return ok(
        paragraphs(
          `${plural(all.length, "webhook endpoint")} (25 allowed per account).`,
          markdownTable(["URL", "Events", "Scope", "Status", "Consecutive failures"], rows),
          health,
        ),
        { webhooks: all, count: all.length },
      );
    }),
  );

  // --------------------------------------------------------------- manage
  if (!readOnly) {
    server.registerTool(
      "everypage_manage_webhook",
      {
        title: "Create, test or delete a webhook",
        description:
          "Manage where EveryPage sends event notifications. Create an endpoint to receive signed deliveries when a " +
          "document is opened, read, downloaded or a lead is captured; send a test delivery to check an endpoint is reachable; " +
          "or delete one. Creating returns a signing secret that is shown only once.",
        inputSchema: {
          action: z.enum(["create", "test", "delete"]).describe("What to do."),
          url: z.string().optional().describe("create: the https:// endpoint that will receive deliveries."),
          events: z
            .array(z.enum(EVENT_KINDS))
            .optional()
            .describe(
              "create: which events to deliver. file.opened fires the moment a reader opens a document; file.viewed fires when " +
                "their reading session ends and carries pages viewed and time spent. gate.completed (captured leads) requires " +
                "the Pro plan at the time the event happens.",
            ),
          format: z
            .enum(["json", "slack"])
            .optional()
            .describe("create: json (signed, for your own code) or slack (Slack Block Kit for an incoming webhook). Default json."),
          file: z
            .string()
            .optional()
            .describe("create: limit deliveries to one document. Omit for the whole account."),
          webhook: z.string().optional().describe("test/delete: the endpoint's id, from everypage_list_webhooks."),
        },
        outputSchema: {
          action: z.string(),
          webhook: z.object({}).passthrough().optional(),
          secret: z.string().optional().describe("Shown exactly once, at creation. Store it now."),
          delivered: z.boolean().optional(),
          status: z.number().optional(),
          latencyMs: z.number().optional(),
          deleted: z.boolean().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      guard(ctx, { action: "managing the webhook", scope: "webhooks:manage" }, async ({ action, url, events, format, file, webhook }): Promise<ToolResult> => {
        if (action === "create") {
          if (!url) throw new ToolInputError("Creating a webhook needs `url` - the https:// endpoint to deliver to.");
          if (!events?.length) {
            throw new ToolInputError(
              `Creating a webhook needs at least one event in \`events\`. Available: ${EVENT_KINDS.join(", ")}.`,
            );
          }

          let fileUuid: string | undefined;
          if (file) fileUuid = (await resolveFile(ctx.http, file)).uuid;

          const result = await ctx.http.json<WebhookCreateResult | { webhook?: Webhook; secret?: string }>({
            method: "POST",
            path: "/api/v1/webhooks",
            jsonBody: {
              url,
              events,
              format: format ?? "json",
              ...(fileUuid ? { fileUuid } : {}),
            },
          });

          // The endpoint answers {webhook, secret}; tolerate a flat shape too.
          const created = ("webhook" in result && result.webhook ? result.webhook : result) as Webhook;
          const secret = (result as { secret?: string }).secret;

          const text = paragraphs(
            secret
              ? `Signing secret: ${secret}\n\nSave this now - EveryPage will never show it again. ` +
                "Deliveries are signed with it: the X-Everypage-Signature header is `t=<unix timestamp>,v1=<hex>`, " +
                "where v1 is HMAC-SHA256 over `<t>.<raw request body>` keyed with the full secret string (the whsec_ prefix included)."
              : "Webhook created.",
            `Endpoint ${url} will receive: ${events.join(", ")}.` +
              (fileUuid ? " Deliveries are limited to that one document." : " Deliveries cover the whole account."),
            events.includes("gate.completed")
              ? "Note: gate.completed only delivers while the account is on the Pro plan - subscribing below Pro succeeds but never fires."
              : "",
            "Use everypage_manage_webhook with action \"test\" to confirm the endpoint is reachable.",
          );

          return ok(text, {
            action,
            webhook: created as unknown as Record<string, unknown>,
            ...(secret ? { secret } : {}),
          });
        }

        if (!webhook) {
          throw new ToolInputError(
            `\`webhook\` is required to ${action} an endpoint. Call everypage_list_webhooks to find its id.`,
          );
        }

        if (action === "test") {
          const result = await ctx.http.json<WebhookTestResult>({
            method: "POST",
            path: `/api/v1/webhooks/${encodeURIComponent(webhook)}/test`,
          });

          const text = result.delivered
            ? `Test delivery succeeded: the endpoint answered ${result.status} in ${result.latencyMs ?? "?"}ms.`
            : `Test delivery failed${result.status ? ` - the endpoint answered ${result.status}` : " - the endpoint could not be reached"}.` +
              (result.error ? ` ${result.error}.` : "") +
              " Check the URL is publicly reachable over https and answers 2xx quickly.";

          return ok(text, {
            action,
            ...(result.delivered !== undefined ? { delivered: result.delivered } : {}),
            ...(result.status !== undefined ? { status: result.status } : {}),
            ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
          });
        }

        await ctx.http.empty({ method: "DELETE", path: `/api/v1/webhooks/${encodeURIComponent(webhook)}` });
        return ok(
          "Webhook endpoint deleted. Any deliveries still queued for it have been discarded, and its signing secret is now useless.",
          { action, deleted: true },
        );
      }),
    );
  }

  // -------------------------------------------------------------- account
  server.registerTool(
    "everypage_account",
    {
      title: "Account and plan",
      description:
        "The connected EveryPage account: which email it belongs to, which plan it is on, and what that plan allows " +
        "(upload size, document count, and which features are locked). Check this before attempting a plan-gated action.",
      inputSchema: {},
      outputSchema: {
        email: z.string().optional(),
        name: z.string().optional(),
        plan: z.string(),
        maxUploadBytes: z.number(),
        maxUploadLabel: z.string(),
        maxActiveFiles: z.number().nullable(),
        lockedFeatures: z.array(z.string()),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(ctx, { action: "reading the account", scope: "profile" }, async (): Promise<ToolResult> => {
      const account = await ctx.plans.account();
      const plan = normalizePlan(account.subscription);
      const caps = PLAN_CAPS[plan];

      const locked = FEATURE_TIERS.filter(({ tier }) => {
        if (plan === "pro") return false;
        if (plan === "basic") return tier === "pro";
        return true;
      }).map(({ feature, tier }) => `${feature} (needs ${tier})`);

      const fileLimit = caps.maxActiveFiles === null ? "unlimited documents" : `up to ${caps.maxActiveFiles} live documents`;

      return ok(
        paragraphs(
          `Connected as ${account.email ?? "(unknown email)"}${account.name ? ` (${account.name})` : ""}, on the ${plan} plan` +
            (account.created_at ? `, member since ${relativeTime(account.created_at)}` : "") +
            ".",
          `This plan allows uploads up to ${caps.maxUploadLabel} and ${fileLimit}. The API is limited to 120 requests per minute.`,
          locked.length
            ? `Not available on this plan:\n${locked.map((l) => `- ${l}`).join("\n")}\n\nUpgrading is done at https://everypage.co/pricing.`
            : "Every EveryPage feature is available on this plan.",
        ),
        {
          ...(account.email ? { email: account.email } : {}),
          ...(account.name ? { name: account.name } : {}),
          plan,
          maxUploadBytes: caps.maxUploadBytes,
          maxUploadLabel: caps.maxUploadLabel,
          maxActiveFiles: caps.maxActiveFiles,
          lockedFeatures: locked,
        },
      );
    }),
  );
}
