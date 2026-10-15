# everypage-mcp

MCP server for [EveryPage](https://everypage.co). Lets an AI assistant turn a PDF
into a tracked share link, and tell you who actually read it — how far they got,
how long they spent, and which page they stopped on.

> "Share this proposal with Jane and Bob, then tell me tomorrow whether either of
> them read past the pricing page."

## § 01 Install

**No install: the hosted server.** EveryPage also runs this server at
`https://everypage.co/mcp` (Streamable HTTP, OAuth sign-in, no API key). In
Claude, open Customize → Connectors → Add custom connector and paste that URL;
in Claude Code, `claude mcp add --transport http everypage https://everypage.co/mcp`.
See [everypage.co/integrations/claude](https://everypage.co/integrations/claude).
Uploads there take an https link rather than a local file path.

**This package (stdio).** Get an API key from [everypage.co/account](https://everypage.co/account) — it
looks like `ep_live_…`. Then point your client at the server.

**Claude Code**

```bash
claude mcp add everypage --env EVERYPAGE_API_KEY=ep_live_... -- npx -y everypage-mcp
```

**Claude Desktop, Cursor, VS Code, and anything else that reads a JSON config**

```json
{
  "mcpServers": {
    "everypage": {
      "command": "npx",
      "args": ["-y", "everypage-mcp"],
      "env": { "EVERYPAGE_API_KEY": "ep_live_..." }
    }
  }
}
```

Requires Node 20 or newer.

## § 02 What it can do

| Tool | What it does |
| --- | --- |
| `everypage_share_pdf` | Upload a PDF (local path or https URL) and get a tracked link, embed code and QR URL — applying share settings in the same call |
| `everypage_list_files` | List documents, optionally filtered by name |
| `everypage_get_file` | One document's links, protection and status |
| `everypage_update_file_settings` | Change passcode, expiry, downloads, viewer mode, email gate, view limit, page range, slug |
| `everypage_delete_file` | Trash a document, or purge it permanently |
| `everypage_replace_content` | Swap the PDF behind a live link, keeping the link and its history · Pro |
| `everypage_get_readership` | Who read it, how far they got, where they dropped off |
| `everypage_list_events` | Recent reads, downloads or captured leads, with a polling cursor |
| `everypage_create_variants` | One tracked link per recipient, so reads are attributed by name · Pro |
| `everypage_list_variants` | Those links and their status |
| `everypage_update_variant` | Rename, revoke or restore one recipient's link · Pro |
| `everypage_delete_variant` | Delete it, or GDPR-redact the recipient's name · Pro |
| `everypage_list_webhooks` | Webhook endpoints and their delivery health |
| `everypage_manage_webhook` | Create, test or delete a webhook endpoint |
| `everypage_account` | The connected account, its plan, and what that plan allows |

Two prompts ship as slash commands: **readership_digest** (what happened over the
last N days) and **send_tracked_copies** (one link per recipient, done right).

## § 03 Things worth knowing

**Any way of naming a document works.** Every tool that takes a `file` accepts a
UUID, a short link id, or a share URL pasted straight out of the browser —
including `/embed/` links and ones carrying `?via=` — so there is no need to look
up an id first.

**Uploads stream.** A local path is read off disk rather than into memory, so a
2 GB document on the Pro plan uploads without the process growing. Files are
checked for the PDF magic bytes and against your plan's size cap *before*
anything is sent.

**A URL is fetched without your credentials.** The `url` lane downloads from the
host you named using no EveryPage headers at all, then uploads the bytes. Your
API key never travels to a third-party host.

**Readership is summarized, not dumped.** The tool computes the finding — the
steepest drop in the reach funnel, the most re-read page — and puts the raw rows
in `structuredContent` for anything that wants to chart them.

**Event cursors are per-stream.** `everypage_list_events` returns a `nextCursor`,
and it is only valid for the same `type`. The three streams have independent id
sequences; crossing them silently returns the wrong window.

**Deleting is reversible by default.** `everypage_delete_file` trashes, and says
so; `purge: true` is the irreversible one. Tools that cannot be undone are marked
with MCP's `destructiveHint`, so clients that support confirmation prompts will
ask before running them.

## § 04 Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `EVERYPAGE_API_KEY` | yes | — | `ep_live_…` API key, or an `ep_at_…` OAuth token (limited to its granted scopes) |
| `EVERYPAGE_BASE_URL` | no | `https://everypage.co` | API origin, for self-hosted or development instances |
| `EVERYPAGE_READ_ONLY` | no | `false` | `true` exposes only the seven read-only tools |

## § 05 Plans

Some features are plan-gated, and a refusal will say which plan is needed.
`everypage_account` reports the current plan and what it locks.

| | Free | Basic | Pro |
| --- | --- | --- | --- |
| Upload size | 20 MiB | 200 MiB | 2 GiB |
| Live documents | 3 | 100 | unlimited |
| Tracked links, share settings, webhooks | ✓ | ✓ | ✓ |
| Passcode, view limits, view notifications, per-page stats | | ✓ | ✓ |
| Per-recipient links, email-capture gate, content replacement, watermarks, page ranges | | | ✓ |

The API allows 120 requests per minute per key.

## § 06 Not included

`/files/claim` and the Canva publishing lane (app plumbing, not agent work),
branding assets and hotspots (large Pro payloads with no natural agent use), and
the authenticated QR fetch — the `qr_url` every tool returns is public and needs
no credentials. Open an issue if you want any of them.

## § 07 Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run inspector      # drive the tools by hand in the MCP inspector
```

The tool surface is snapshotted in `test/schemas.test.ts`: renaming a tool or one
of its inputs fails CI on purpose, because it breaks every saved prompt and agent
config that names it.

Field names and output shapes are pinned by the cross-integration contract shared
with the EveryPage Zapier, Make and n8n integrations — change that first.

## § 08 Links

- [EveryPage](https://everypage.co) · [MCP integration page](https://everypage.co/integrations/mcp)
- [Developer API](https://everypage.co/developers) · [OpenAPI spec](https://everypage.co/openapi.yaml)
- [Docs](https://everypage.co/docs) · [Support](mailto:support@everypage.co)

## License

[MIT](./LICENSE)
