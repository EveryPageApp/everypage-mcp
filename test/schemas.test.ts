/**
 * The tool surface is a public contract.
 *
 * Renaming a tool, or renaming one of its inputs, silently breaks every saved
 * prompt, agent configuration and workflow that names it - and the breakage is
 * invisible until someone's automation stops working. So the surface is
 * snapshotted here: a rename fails CI, and updating the snapshot has to be a
 * deliberate act with a version bump behind it.
 */

import { describe, expect, it } from "vitest";

import { harness, type Harness } from "./helpers.js";

async function toolSurface(readOnly = false): Promise<Record<string, string[]>> {
  const h: Harness = await harness([], { readOnly });
  try {
    const { tools } = await h.client.listTools();
    const surface: Record<string, string[]> = {};
    for (const tool of tools) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      surface[tool.name] = Object.keys(properties).sort();
    }
    return surface;
  } finally {
    await h.close();
  }
}

describe("tool surface", () => {
  it("matches the published contract", async () => {
    expect(await toolSurface()).toEqual({
      everypage_account: [],
      everypage_create_variants: ["file", "recipients"],
      everypage_delete_file: ["file", "purge"],
      everypage_delete_variant: ["file", "redact", "variant"],
      everypage_get_file: ["file"],
      everypage_get_readership: ["file", "includePages", "includeProofing"],
      everypage_list_events: ["file", "limit", "since", "type"],
      everypage_list_files: ["limit", "query"],
      everypage_list_variants: ["file"],
      everypage_list_webhooks: [],
      everypage_manage_webhook: ["action", "events", "file", "format", "url", "webhook"],
      everypage_replace_content: ["file", "keepAnchors", "path", "url"],
      everypage_share_pdf: [
        "allowDownload",
        "askReceipt",
        "expiryHours",
        "filename",
        "gateDomains",
        "neverExpire",
        "notifyOnView",
        "pageFrom",
        "pageTo",
        "passcode",
        "path",
        "requireEmail",
        "slug",
        "url",
        "viewLimit",
        "viewerMode",
        "watermark",
      ],
      everypage_update_file_settings: [
        "allowDownload",
        "askReceipt",
        "clearPasscode",
        "expiryHours",
        "file",
        "gateDomains",
        "neverExpire",
        "notifyOnView",
        "pageFrom",
        "pageTo",
        "passcode",
        "requireEmail",
        "slug",
        "viewLimit",
        "viewerMode",
        "watermark",
      ],
      everypage_update_variant: ["allowDownload", "file", "label", "pageFrom", "pageTo", "revoked", "variant"],
    });
  });

  it("stays small enough not to degrade tool selection", async () => {
    // Model accuracy falls off as the tool list grows. If a change pushes past
    // this, fold operations together rather than raising the number.
    expect(Object.keys(await toolSurface()).length).toBeLessThanOrEqual(18);
  });

  it("exposes only read-only tools when EVERYPAGE_READ_ONLY is set", async () => {
    expect(Object.keys(await toolSurface(true)).sort()).toEqual([
      "everypage_account",
      "everypage_get_file",
      "everypage_get_readership",
      "everypage_list_events",
      "everypage_list_files",
      "everypage_list_variants",
      "everypage_list_webhooks",
    ]);
  });

  it("annotates every tool, and marks exactly the irreversible ones destructive", async () => {
    const h = await harness([]);
    try {
      const { tools } = await h.client.listTools();

      for (const tool of tools) {
        expect(tool.annotations, `${tool.name} has no annotations`).toBeDefined();
        expect(tool.description, `${tool.name} has no description`).toBeTruthy();
      }

      const destructive = tools
        .filter((t) => t.annotations?.destructiveHint)
        .map((t) => t.name)
        .sort();
      expect(destructive).toEqual([
        "everypage_delete_file",
        "everypage_delete_variant",
        // create/test are harmless, but delete shares the tool, so the whole
        // tool carries the hint - clients confirm-prompt on it.
        "everypage_manage_webhook",
        "everypage_replace_content",
      ]);

      const readOnlyTools = tools
        .filter((t) => t.annotations?.readOnlyHint)
        .map((t) => t.name)
        .sort();
      expect(readOnlyTools).toEqual([
        "everypage_account",
        "everypage_get_file",
        "everypage_get_readership",
        "everypage_list_events",
        "everypage_list_files",
        "everypage_list_variants",
        "everypage_list_webhooks",
      ]);

      // Nothing may be both.
      expect(tools.filter((t) => t.annotations?.readOnlyHint && t.annotations?.destructiveHint)).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("declares an output schema wherever it returns structured content", async () => {
    const h = await harness([]);
    try {
      const { tools } = await h.client.listTools();
      const missing = tools.filter((t) => !t.outputSchema).map((t) => t.name);
      expect(missing).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it("registers both prompts", async () => {
    const h = await harness([]);
    try {
      const { prompts } = await h.client.listPrompts();
      expect(prompts.map((p) => p.name).sort()).toEqual(["readership_digest", "send_tracked_copies"]);
    } finally {
      await h.close();
    }
  });
});
