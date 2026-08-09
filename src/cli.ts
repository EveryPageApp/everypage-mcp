/**
 * The `everypage-mcp` binary.
 *
 * stdio transport: stdout is the JSON-RPC channel and must carry nothing
 * else, so every diagnostic goes to stderr. A stray console.log here corrupts
 * the protocol stream and the host reports an unhelpful parse error.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, loadConfig } from "./config.js";
import { SERVER_VERSION, buildServer } from "./server.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      [
        "everypage-mcp - MCP server for EveryPage (https://everypage.co)",
        "",
        "Runs over stdio; launch it from an MCP client rather than by hand.",
        "",
        "Environment:",
        "  EVERYPAGE_API_KEY    Required. An API key from https://everypage.co/account.",
        "  EVERYPAGE_BASE_URL   Optional. Defaults to https://everypage.co.",
        "  EVERYPAGE_READ_ONLY  Optional. true exposes only the read-only tools.",
        "",
        "Claude Code:",
        "  claude mcp add everypage --env EVERYPAGE_API_KEY=ep_live_... -- npx -y everypage-mcp",
        "",
      ].join("\n"),
    );
    return;
  }

  const config = loadConfig();
  const server = buildServer(config);
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // A config problem is the user's to fix and deserves a plain sentence;
  // anything else gets a stack trace, because it is ours.
  if (err instanceof ConfigError) {
    process.stderr.write(`everypage-mcp: ${err.message}\n`);
  } else {
    process.stderr.write(`everypage-mcp failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  }
  process.exitCode = 1;
});
