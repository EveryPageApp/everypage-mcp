/**
 * The share trio.
 *
 * Pinned by integrations/AUTOMATION-MATRIX.md §1 - these three keys and their
 * construction rules are identical across the Zapier, Make, n8n and MCP
 * integrations, and the WordPress plugin and oEmbed endpoint agree with them.
 * Change the matrix before changing this file.
 *
 *   shareUrl   {base}/{shortId || uuid}
 *   embed_code <iframe src="{base}/embed/{shortId || uuid}" ...>
 *   qr_url     {base}/api/files/{uuid}/qr-code
 *
 * Two rules are load-bearing:
 *
 *  - **Never a vanity slug.** Slugs are renameable and resolve only on the
 *    owner's custom domain, and trio outputs land in frozen places - emails,
 *    CRM notes, printed QR codes.
 *  - **qr_url is always the public path and always the uuid.** The endpoint is
 *    uuid-keyed, and whoever renders the QR has no EveryPage credentials.
 *    It is also deliberately absent from the custom-domain path allowlist
 *    (backend/internal/handlers/hostguard.go), so it only works on {base}.
 */

export interface ShareTrio {
  shareUrl: string;
  qr_url: string;
  embed_code: string;
}

export interface TrioSource {
  uuid: string;
  shortId?: string | undefined;
}

/** The identifier human-facing links prefer: short id when present, else uuid. */
export function preferredId(file: TrioSource): string {
  return file.shortId?.trim() || file.uuid;
}

export function shareUrl(baseUrl: string, file: TrioSource): string {
  return `${baseUrl}/${preferredId(file)}`;
}

/**
 * The dedicated /embed/ path, not the bare share URL - bare share URLs are
 * CSP-unframable.
 */
export function embedUrl(baseUrl: string, file: TrioSource): string {
  return `${baseUrl}/embed/${preferredId(file)}`;
}

export function embedCode(baseUrl: string, file: TrioSource): string {
  return `<iframe src="${embedUrl(baseUrl, file)}" width="800" height="600" frameborder="0" allowfullscreen></iframe>`;
}

export function qrUrl(baseUrl: string, file: TrioSource): string {
  return `${baseUrl}/api/files/${file.uuid}/qr-code`;
}

export function shareTrio(baseUrl: string, file: TrioSource): ShareTrio {
  return {
    shareUrl: shareUrl(baseUrl, file),
    qr_url: qrUrl(baseUrl, file),
    embed_code: embedCode(baseUrl, file),
  };
}
