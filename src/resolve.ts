/**
 * Turning whatever the user said into a file identifier.
 *
 * The other automation platforms pick documents from a dropdown, so their
 * `file` value is always a canonical uuid. An LLM has no dropdown, and its
 * user pastes share links - so this accepts all three identifier forms plus a
 * full URL wrapping any of them (AUTOMATION-MATRIX.md D20).
 *
 * The three forms, disjoint by construction (backend handlers/resolve.go):
 *   - uuid       36 chars, 8-4-4-4-12 hex
 *   - short id   12 chars base62, ALWAYS at least one uppercase letter
 *   - slug       all-lowercase vanity name, Pro, custom domains only
 *
 * Reads accept any of them. WRITES are uuid-keyed, so anything else has to be
 * resolved to its canonical uuid with a GET first.
 */

import type { HttpClient } from "./http.js";
import type { EveryPageFile } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/**
 * Strips a pasted URL down to its identifier segment.
 *
 * Handles the share URL (`https://everypage.co/aB3xY9kQ2mZ7`), the embed URL
 * (`/embed/<id>`), the SPA's configure and readership routes, and a trailing
 * `/share/file`. Query strings and fragments are dropped - share links
 * routinely carry `?via=email` and similar.
 *
 * Anything that is not a URL is returned trimmed and unchanged, so a bare
 * uuid or short id passes straight through.
 */
export function extractIdentifier(input: string): string {
  const raw = input.trim();
  if (!raw) return raw;

  let path: string;
  if (/^https?:\/\//i.test(raw)) {
    try {
      path = new URL(raw).pathname;
    } catch {
      return raw;
    }
  } else if (raw.includes("/")) {
    // A path fragment without a scheme, e.g. "/embed/aB3xY9kQ2mZ7".
    path = raw.split("?")[0]!.split("#")[0]!;
  } else {
    return raw;
  }

  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return raw;

  // Drop route words that wrap the identifier rather than being one.
  const NOISE = new Set(["embed", "readership", "configure", "share", "file"]);
  const meaningful = segments.filter((s) => !NOISE.has(s.toLowerCase()));

  // The identifier is the last meaningful segment: /embed/<id>, /<id>/configure
  // and /readership/<id> all reduce correctly.
  return meaningful[meaningful.length - 1] ?? raw;
}

export interface ResolvedFile {
  /** The canonical uuid - safe to use on write endpoints. */
  uuid: string;
  shortId?: string | undefined;
  /** The full file record, when a lookup happened. */
  file?: EveryPageFile;
}

/**
 * Resolves any identifier form to a canonical uuid.
 *
 * A uuid is returned without a round trip. Anything else costs one GET, whose
 * result is handed back so callers that also want the file record (nearly all
 * of them - the share trio needs `shortId`) don't fetch it twice.
 */
export async function resolveFile(http: HttpClient, input: string): Promise<ResolvedFile> {
  const id = extractIdentifier(input);
  if (isUuid(id)) return { uuid: id };

  const file = await http.json<EveryPageFile>({
    method: "GET",
    path: `/api/v1/files/${encodeURIComponent(id)}`,
  });
  return { uuid: file.uuid, shortId: file.shortId, file };
}
