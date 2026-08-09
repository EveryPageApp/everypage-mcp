/**
 * The npm package and the registry manifest have to agree, and both have to
 * agree with the code. The registry validates the published tarball's
 * `mcpName` against the server.json `name` at publish time - a mismatch fails
 * there, long after the release has gone out, so it is checked here instead.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SERVER_VERSION } from "../src/server.js";

const read = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8"));

const pkg = read("package.json");
const manifest = read("server.json");
const npmPackage = (manifest.packages as Record<string, unknown>[])[0]!;

describe("package.json / server.json", () => {
  it("uses the reverse-DNS namespace we can prove we own", () => {
    // Domain-verified via a TXT record on everypage.co. Changing this is
    // changing the server's identity in the registry - see PUBLISHING.md.
    expect(manifest.name).toBe("co.everypage/mcp");
  });

  it("carries mcpName matching the manifest name - the registry's ownership proof", () => {
    expect(pkg.mcpName).toBe(manifest.name);
  });

  it("keeps every version in step", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(npmPackage.version).toBe(pkg.version);
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it("points the manifest at the package npm actually publishes", () => {
    expect(npmPackage.identifier).toBe(pkg.name);
    expect(npmPackage.registryType).toBe("npm");
  });

  it("ships the bin and the manifest in the tarball", () => {
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("server.json");
    expect((pkg.bin as Record<string, string>)["everypage-mcp"]).toBe("dist/cli.js");
  });

  it("stays inside the registry's 100-character description limit", () => {
    expect((manifest.description as string).length).toBeLessThanOrEqual(100);
  });

  it("declares the API key as required and secret", () => {
    const vars = npmPackage.environmentVariables as Record<string, unknown>[];
    const apiKey = vars.find((v) => v.name === "EVERYPAGE_API_KEY");
    expect(apiKey).toMatchObject({ isRequired: true, isSecret: true });
  });

  it("requires Node 20 - fs.openAsBlob streams large uploads off disk", () => {
    expect((pkg.engines as Record<string, string>).node).toBe(">=20");
  });
});
