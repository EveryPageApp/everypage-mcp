/**
 * Prompts - the two workflows worth spelling out.
 *
 * A prompt is a slash command in most hosts, so these encode the sequences a
 * user would otherwise have to describe every time, including the parts that
 * are easy to get wrong (per-type cursors; one variant per recipient).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "readership_digest",
    {
      title: "Readership digest",
      description: "Summarize who read which documents recently, and what changed.",
      argsSchema: {
        days: z
          .string()
          .optional()
          .describe("How many days back to cover. Defaults to 7."),
      },
    },
    ({ days }) => {
      const window = days?.trim() || "7";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text:
                `Give me a readership digest for my EveryPage documents covering the last ${window} days.\n\n` +
                "Do this:\n" +
                "1. Call everypage_list_files to see what documents exist.\n" +
                "2. Call everypage_list_events (type \"view\") for recent reads, and again with type \"download\" and " +
                "type \"gate\" if the plan allows. Remember each type has its own cursor - never reuse one across types.\n" +
                "3. For the documents that actually saw activity, call everypage_get_readership for the detail.\n\n" +
                "Then write a short digest covering: which document got the most attention, anything that was read " +
                "unusually thoroughly or abandoned early (name the page people stop on), any new leads captured by an " +
                "email gate, and anything worth acting on. Lead with the finding, not the method. If nothing happened, " +
                "say so in one line rather than padding.",
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "send_tracked_copies",
    {
      title: "Send tracked copies",
      description: "Mint a separate tracked link for each recipient of a document, so reads are attributed by name.",
      argsSchema: {
        file: z.string().describe("The document: a name, UUID, short link id, or a pasted share URL."),
        recipients: z.string().describe("Who to send it to - a comma-separated list of names."),
      },
    },
    ({ file, recipients }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `I want to send "${file}" to these people, with a separate tracked link each: ${recipients}.\n\n` +
              "Do this:\n" +
              "1. If that document reference is a name rather than an id, find it with everypage_list_files first.\n" +
              "2. Call everypage_create_variants ONCE with every recipient in the recipients array - not one call per " +
              "person. Use each person's name as their label.\n" +
              "3. Give me back a table of recipient to link.\n\n" +
              "Per-recipient links need the Pro plan; if that fails, tell me and offer the single shared link instead. " +
              "Remind me at the end that each person must get only their own link, or the attribution is meaningless.",
          },
        },
      ],
    }),
  );
}
