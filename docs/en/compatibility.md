# Compatibility

[Home](../../README.md) · [简体中文](../zh/compatibility.md)

## Implemented contract

OwnContext exposes `/mcp` using Streamable HTTP through the Cloudflare Agents MCP handler. OAuth is provided by `@cloudflare/workers-oauth-provider`: resource/server metadata discovery, dynamic client registration, Client ID Metadata Documents, browser consent, and authorization-code authentication are configured. The GitHub upstream flow uses state and S256 PKCE.

A client must support this HTTP and OAuth contract and complete browser sign-in with the allowed GitHub identity. No stdio adapter, legacy `/sse` endpoint, GitHub-token bypass, or public read endpoint is provided. `/health` is public but returns only service name, version, and build fingerprint after configuration validation; it does not check GitHub reachability.

## Verification boundary

| Surface | Evidence in this source tree | Release status |
| --- | --- | --- |
| In-memory demo | `tests/cli-demo.test.ts` and `npm run demo` | Exercised locally on macOS with Node 24 |
| MCP HTTP / OAuth | `tests/http-auth.test.ts`, `tests/cli-doctor.test.ts`; real Worker handler and OAuth library, fake GitHub/KV | Local integration coverage, not a deployed OAuth acceptance |
| Setup lifecycle | `tests/cli-setup.test.ts`; external commands are stubbed | Creation, resume, cancellation, and secret handling tested locally |
| Worker bundle | `npm run build` uses Wrangler dry-run | Offline packaging check only |
| Claude Code | Setup prints `claude mcp add --transport http ...` | Recipe supplied; live client acceptance pending |
| claude.ai | Setup prints custom-connector configuration | Recipe supplied; live client acceptance pending |

The demo's two clients are in-memory tool adapters. Doctor acceptance uses two MCP SDK connections. Neither establishes that two named AI products have been tested together. Client availability can vary with plan, organization policy, and version. Treat other MCP clients as candidates for testing, not a compatibility promise.

## Runtime and platforms

- CLI: Node.js 24.11+ with npm. Setup additionally needs Git, GitHub CLI, and the project's bundled Wrangler on npm's script PATH.
- Hosting: Cloudflare Workers with `nodejs_compat`, `global_fetch_strictly_public`, and an `OAUTH_KV` binding. The compatibility date is pinned in the supplied configuration.
- Storage and identity: GitHub.com, a private repository's default branch, and one GitHub identity. GitHub Enterprise and other Git hosts are outside this adapter.
- Local execution has been exercised on macOS. CI is configured for Ubuntu and Node 24. Native Windows setup has not been validated; `scripts/wrangler.sh` specifically requires Bash.
- `LOCALE=en` or `zh` affects generated labels. Consent and CLI messages are English. Time-zone handling uses an IANA zone; the default is UTC.

## Capacity and semantics

Readable files are limited to 200 KiB. A truncated GitHub repository tree is rejected. Search scans at most 25 files per page and returns at most 30 hits with neighboring lines; result byte limits can end a page earlier. Follow `next_cursor` even after an empty page. If the tree changes, restart the search.

Brief context returns bounded profile cards (180, 300, and 120 characters) with source paths and SHAs. Read full sources for citations or truncated text. Full context and search have bounded output; large base context must be read individually.

SHA compare-and-swap is per file, not a multi-file transaction. An identical already-applied `update_note` can return `unchanged` even with an old SHA; a different stale body is rejected. GitHub API rate limits and network latency remain in the request path. There is no local vector index or background synchronization daemon.
