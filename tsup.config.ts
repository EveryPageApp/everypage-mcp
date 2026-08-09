import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  // The bin is executed, never imported - type declarations would be dead
  // weight in the tarball.
  dts: false,
  // Deps stay external: `npx everypage-mcp` installs them, and bundling the
  // MCP SDK would defeat the dedupe npm does when several servers share it.
  external: ["@modelcontextprotocol/sdk", "zod"],
  banner: { js: "#!/usr/bin/env node" },
});
