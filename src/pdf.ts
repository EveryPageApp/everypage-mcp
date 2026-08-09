/**
 * Getting PDF bytes to the API, from a local path or a URL.
 *
 * Being a local process is the whole advantage of a stdio MCP server: the
 * document the user is talking about is usually sitting on their disk. That
 * makes reading a path the primary lane, and it has to behave - a 2 GiB Pro
 * upload must not be buffered in memory, and a non-PDF must be refused before
 * anything crosses the network.
 *
 * The URL lane deliberately fetches WITHOUT credentials and re-uploads,
 * rather than calling the API's `/files/import`: that endpoint is
 * host-allowlisted for Canva exports and 403s everything else. This mirrors
 * n8n exactly (AUTOMATION-MATRIX.md D5/D6) - and the API key must never
 * travel to a host the user named.
 */

import { openAsBlob } from "node:fs";
import { stat, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { ToolInputError } from "./errors.js";
import { humanBytes } from "./format.js";

const PDF_MAGIC = "%PDF-";

export interface PdfSource {
  blob: Blob;
  filename: string;
  size: number;
  /** Called once the upload finishes, successfully or not. */
  cleanup: () => Promise<void>;
}

function assertPdfMagic(head: Uint8Array, what: string): void {
  const prefix = Buffer.from(head.subarray(0, PDF_MAGIC.length)).toString("latin1");
  if (prefix !== PDF_MAGIC) {
    throw new ToolInputError(
      `${what} is not a PDF (it does not start with "%PDF-"). EveryPage accepts PDF files only - ` +
        "convert the document first, then try again.",
    );
  }
}

function assertWithinCap(size: number, cap: number, capLabel: string, plan: string | null): void {
  if (size <= cap) return;
  const planPhrase = plan ? `the ${plan} plan's ${capLabel} limit` : `the ${capLabel} upload limit`;
  throw new ToolInputError(
    `That PDF is ${humanBytes(size)}, which exceeds ${planPhrase}. ` +
      "Upload caps are 20 MiB on free, 200 MiB on basic and 2 GiB on pro. " +
      "Send a smaller file, or tell the user they can upgrade at https://everypage.co/pricing.",
  );
}

export interface SourceOptions {
  /** Client-side size cap for the account's plan. */
  maxBytes: number;
  maxBytesLabel: string;
  plan: string | null;
  filename?: string | undefined;
  /** Injectable for tests. */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * A local file, streamed. `openAsBlob` gives a size-known Blob backed by the
 * file rather than a buffer, so `fetch` streams it off disk - this is why the
 * package requires Node 20.
 */
export async function sourceFromPath(path: string, options: SourceOptions): Promise<PdfSource> {
  if (!isAbsolute(path)) {
    throw new ToolInputError(
      `"${path}" is not an absolute path. Pass the full path to the PDF, e.g. /Users/you/Documents/proposal.pdf.`,
    );
  }

  let stats;
  try {
    stats = await stat(path);
  } catch {
    throw new ToolInputError(`No file exists at "${path}". Check the path and try again.`);
  }
  if (stats.isDirectory()) {
    throw new ToolInputError(`"${path}" is a directory, not a PDF file.`);
  }
  if (stats.size === 0) {
    throw new ToolInputError(`"${path}" is empty (0 bytes).`);
  }

  // Sniff before the size check so "that's not even a PDF" wins over "that
  // PDF is too big" - it is the more useful complaint.
  const blob = await openAsBlob(path, { type: "application/pdf" });
  const head = new Uint8Array(await blob.slice(0, PDF_MAGIC.length).arrayBuffer());
  assertPdfMagic(head, `"${basename(path)}"`);
  assertWithinCap(stats.size, options.maxBytes, options.maxBytesLabel, options.plan);

  return {
    blob,
    filename: options.filename?.trim() || basename(path),
    size: stats.size,
    cleanup: async () => {},
  };
}

/**
 * A remote URL, fetched without credentials and spooled to a temp file.
 *
 * Spooling rather than buffering keeps a large download off the heap, and
 * gives the same streamed upload as the local-path lane. The temp file is
 * always removed, including on failure.
 */
export async function sourceFromUrl(url: string, options: SourceOptions): Promise<PdfSource> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolInputError(`"${url}" is not a valid URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new ToolInputError(
      `Only https:// URLs are supported (got "${parsed.protocol}//"). ` +
        "Use an https link, or download the file and pass its local path instead.",
    );
  }

  const doFetch = options.fetchFn ?? globalThis.fetch;
  let res: Response;
  try {
    // No Authorization header, ever: this is a host the user named, and the
    // EveryPage key must not leak to it.
    res = await doFetch(parsed.toString(), { redirect: "follow" });
  } catch (err) {
    throw new ToolInputError(
      `Could not reach ${parsed.host}: ${err instanceof Error ? err.message : String(err)}. ` +
        "Check the URL, or download the file and pass its local path instead.",
    );
  }
  if (!res.ok) {
    throw new ToolInputError(
      `${parsed.host} answered ${res.status} for that URL. It may require a login, or the link may have expired. ` +
        "Download the file and pass its local path instead.",
    );
  }

  // Content-Length is a hint, not a promise, so it is checked here as a fast
  // rejection and the real size is checked again after the body lands.
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared)) {
    assertWithinCap(declared, options.maxBytes, options.maxBytesLabel, options.plan);
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  assertPdfMagic(bytes, `The file at ${parsed.host}`);
  assertWithinCap(bytes.length, options.maxBytes, options.maxBytesLabel, options.plan);

  const tempPath = join(tmpdir(), `everypage-mcp-${randomUUID()}.pdf`);
  await writeFile(tempPath, bytes);

  const blob = await openAsBlob(tempPath, { type: "application/pdf" });
  return {
    blob,
    filename: options.filename?.trim() || filenameFromUrl(parsed),
    size: bytes.length,
    cleanup: async () => {
      await unlink(tempPath).catch(() => undefined);
    },
  };
}

/** Best-effort display name from a URL path; always ends in .pdf. */
export function filenameFromUrl(url: URL): string {
  const last = url.pathname.split("/").filter(Boolean).pop();
  if (!last) return "document.pdf";
  const decoded = safeDecode(last);
  return /\.pdf$/i.test(decoded) ? decoded : `${decoded}.pdf`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Builds the multipart body the upload endpoint expects (part name `file`). */
export function uploadForm(source: PdfSource): FormData {
  const form = new FormData();
  form.append("file", source.blob, source.filename);
  return form;
}
