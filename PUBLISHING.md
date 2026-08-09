# Publishing everypage-mcp

Internal runbook. Two destinations — npm, then the MCP registry — and the order
matters: the registry validates the *published* npm package's `mcpName` field, so
a registry publish before the npm publish fails.

## 0. Identity

This repo lives at `github.com/EveryPageApp/everypage-mcp`. Commits and pushes use
the EveryPage identity only — never the personal account.

```bash
git config user.name "EveryPage"
git config user.email "hello@everypage.co"
gh auth switch --user EveryPageApp
# ... push ...
gh auth switch --user nickzer0
```

Check before pushing: `git log --format='%an <%ae>' | sort -u` must show only
`EveryPage <hello@everypage.co>`, and no `Co-Authored-By` trailers.

## 1. Pre-flight

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run        # confirm dist/ and server.json are in the tarball
```

`test/manifest.test.ts` already checks that `package.json` and `server.json` agree
on the version, the package name and `mcpName` — but bump all of `package.json`
`version`, `server.json` `version`, `server.json` `packages[0].version` and
`SERVER_VERSION` in `src/server.ts` together, or it fails.

Drive the changed tools by hand before releasing:

```bash
EVERYPAGE_API_KEY=ep_live_... npm run inspector
```

## 2. npm

Publishing is done by CI, not by hand: `.github/workflows/release.yml` fires on a
published GitHub release and uses **npm Trusted Publishers (OIDC)** — no token is
stored anywhere.

One-time setup on npmjs.com, under the package's settings → Trusted Publishers:
add `EveryPageApp/everypage-mcp` with workflow `release.yml`.

To release:

```bash
git tag v0.1.0 && git push origin v0.1.0
gh release create v0.1.0 --generate-notes
```

Then confirm the published tarball actually carries the ownership marker — the
registry reads this exact field:

```bash
npm view everypage-mcp mcpName     # must print co.everypage/mcp
```

## 3. MCP registry

The registry name is `co.everypage/mcp`, a **domain-verified** namespace. That
verification is a signature over a challenge, checked against a TXT record on
everypage.co — which means the private key is the credential for the whole
`co.everypage/*` namespace, reusable for any future EveryPage MCP server.

### First time only: mint the key and publish the TXT record

```bash
brew install mcp-publisher     # or grab the binary from the registry's releases

openssl genpkey -algorithm Ed25519 -out key.pem
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "everypage.co. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""
```

Add that TXT record to the everypage.co zone in Cloudflare, then wait for it:

```bash
dig +short TXT everypage.co | grep MCPv1
```

**Store `key.pem` in the password manager.** It is gitignored here, and losing it
means losing the ability to publish under `co.everypage/*` until a new record
propagates.

### Every release

```bash
PRIVATE_KEY="$(openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
mcp-publisher login dns --domain everypage.co --private-key "${PRIVATE_KEY}"
mcp-publisher publish
```

Verify it took:

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=everypage" | jq
```

## 4. After go-live

- [ ] Add the registry listing URL to `Organization.sameAs` in
      `frontend/index.html` — **only once it resolves and shows EveryPage
      branding**. A `sameAs` pointing at a dead profile is worse than none.
- [ ] Flip the badge on `IntegrationsHub.vue` from `badgeEarly` to
      `badgeAvailable`.
- [ ] Close the issue with links to the npm package and the registry entry.

## Notes

- The registry publish is deliberately **not** in CI: the DNS signing key would
  have to live in Actions secrets, and it grants the whole namespace.
- `description` in `server.json` is capped at 100 characters by the registry
  schema (pinned by a test).
- A future hosted server would be a `remotes` entry alongside the existing
  `packages` entry in the same `server.json`, so the listing upgrades in place on
  a version bump rather than becoming a second entry.
