# Costs and limits

[Home](../../README.md) · [简体中文](../zh/costs.md)

OwnContext is free software. Running it uses your Cloudflare and GitHub accounts. A deployment can fit within their free allowances, but request volume alone does not establish that it will: CPU time and OAuth storage operations also matter. Prices below are in USD; official sources were read on **2026-10-25**. Check those pages before choosing a plan.

## What the Worker uses

| Component | Use in OwnContext |
| --- | --- |
| Cloudflare Worker | HTTP MCP requests, OAuth endpoints, and `/health` |
| Workers KV | The `OAUTH_KV` namespace holds OAuth registrations, grants, token records, and authorization-flow state |
| GitHub.com | A private repository holds text and Git history; REST requests read metadata, trees and blobs, and write file contents |
| AI client and model provider | Your subscriptions and model usage are separate from OwnContext |

The shipped configuration uses no D1, Durable Objects, R2, vector database, or scheduled job. The MCP handler is stateless; note contents are fetched from GitHub rather than stored in KV. OwnContext makes no model or embedding calls. Optional snippet and logging tools write to the same GitHub repository. See [runtime](../../src/index.ts), [bindings](../../wrangler.jsonc), [repository adapter](../../src/github.ts), and [privacy](privacy-and-data-flow.md).

## Cloudflare Workers

Sources: [Workers pricing][workers-pricing] and [Workers limits][workers-limits], read 2026-10-25.

| Meter | Free | Workers Paid, Standard pricing |
| --- | --- | --- |
| Base charge | $0 | Minimum $5/month per account |
| Incoming requests | 100,000/day per account; resets at 00:00 UTC | 10 million/month included; $0.30 per additional million; no daily request limit |
| CPU time | 10 ms per invocation | 30 million CPU-ms/month included; $0.02 per additional million CPU-ms |
| CPU limit per HTTP invocation | 10 ms | Default 30 seconds; configurable up to 300 seconds |
| Memory | 128 MB per isolate | 128 MB per isolate |

Waiting for GitHub or KV does not consume CPU time. JSON processing, text scanning, and cryptography do. Measure your deployed workload, especially searches and OAuth, before relying on the Free CPU limit. The current configuration does not customize the CPU limit.

Outbound GitHub fetches are subrequests, not additional billable incoming Worker requests. Workers has no egress/bandwidth charge. Free Workers allow 50 outbound fetch subrequests per invocation; a search page can make up to 27 GitHub requests in the normal path described below. Pagination keeps each page bounded, but does not remove the total GitHub cost.

Client initialization, tool discovery, authentication, retries, and health checks add incoming requests beyond tool calls. Other Workers on your account also consume the Free request allowance. Exceeding the Free request allowance or invocation CPU limit can make the endpoint unavailable; it does not silently become a paid deployment.

## Workers KV

Sources: [KV pricing][kv-pricing] and [KV limits][kv-limits], read 2026-10-25. Paid allowances below accompany the Workers Paid plan; the $5 base charge above is not a second KV subscription.

| Meter | Free | Paid included usage, then overage |
| --- | --- | --- |
| Reads | 100,000/day | 10 million/month; $0.50 per additional million |
| Writes | 1,000/day | 1 million/month; $5 per additional million |
| Deletes | 1,000/day | 1 million/month; $5 per additional million |
| Lists | 1,000/day | 1 million/month; $5 per additional million |
| Stored data | 1 GB | 1 GB; $0.50 per additional GB-month |

Free operation allowances reset at 00:00 UTC. Operations exceeding a category's allowance fail. Both plans limit writes to the same key to one per second and values to 25 MiB. OwnContext's 200 KiB note limit applies to GitHub files, independently of KV.

OAuth authentication reads KV. Registration, consent, token issuance/refresh, and revocation also use KV; their operation counts depend on the client flow and the pinned OAuth provider library. Repeated connections and token refreshes therefore need a separate allowance from note activity. Monitor these meters in your Cloudflare account rather than treating one note write as one KV write.

## GitHub limits and calls per operation

[GitHub Free][github-plans] includes unlimited private repositories with a limited feature set. OwnContext's storage adapter uses ordinary repository files; it does not require Git LFS, Packages, Codespaces, or Actions for runtime storage.

The Worker authenticates repository REST calls with `OWNCONTEXT_GITHUB_TOKEN`, a fine-grained personal access token. The normal authenticated-user limit is **5,000 REST requests/hour**. This is shared with other personal-token and user-authorized app activity for that user, not a fresh allowance per client or token. GitHub OAuth sign-in uses a separate identity-only token for `GET /user`; it does not turn repository access into a GitHub App installation quota. See [authentication](../../src/auth.ts) and [GitHub REST rate limits][github-limits], read 2026-10-25.

GitHub also applies secondary limits, including 100 concurrent requests across REST and GraphQL, generally 900 REST points/minute per endpoint, and generally 80 content-generating requests/minute and 500/hour. Most reads cost one secondary-limit point and most writes cost five; GitHub can impose additional limits. A modest hourly request total does not permit an arbitrary burst of writes.

For one tool call in a fresh MCP request, without conflicts or network errors:

| Operation | Repository REST requests | New commits |
| --- | --- | --- |
| `read` an existing file | 3: repository metadata, recursive tree, blob | 0 |
| `get_context` in brief mode | Up to 5: metadata, tree, three profile blobs | 0 |
| One `search` page | Up to 27: metadata, tree, up to 25 blobs | 0 |
| `get_context` in full mode, one page | Up to 31: metadata, tree, four base files and up to 25 index files | 0 |
| `remember` or `update_note`, changed existing note | 4: metadata, tree, blob, Contents `PUT` | 1 |
| `remember` or `update_note`, new note | 3: metadata, tree, Contents `PUT` | 1 |
| Duplicate `remember` or unchanged `update_note` | 3 for an existing note; no `PUT` | 0 |

The [repository adapter](../../src/github.ts) caches the tree and blobs within its instance; [server construction](../../src/tools.ts) creates that service for the request. The table assumes distinct blob contents and does not rely on a cache across HTTP requests. Full-context base and index files can overlap, reducing fetches. Each successful [Contents `PUT`][github-contents] creates the commit and returns its SHA; OwnContext does not make another commits-API request. The [tool implementation](../../src/knowledge.ts) defines pagination and duplicate handling.

`remember` and optional append-style tools retry `409`/`422` write conflicts up to four total attempts, adding tree reads and potentially blob reads and writes. The adapter does **not** automatically back off on GitHub `403`/`429` limits, and its tool error does not forward `Retry-After` or `x-ratelimit-reset`. It returns `github_request_failed` with the upstream status. Stop repeated calls when throttled. GitHub's guidance is to honor `Retry-After`, otherwise wait until `x-ratelimit-reset` for an exhausted primary limit, or at least one minute for a secondary limit, with increasing delays on repeated failures. A `403` can also indicate a permission problem.

## Single-user estimate

**Illustrative estimate, not a benchmark or a free-tier guarantee:** assume one day contains 10 brief-context calls, 20 search pages scanning 25 distinct blobs each, 60 existing-file reads, and 10 successful new-fact writes to existing notes. Each call uses a fresh request; there are no conflicts or retries.

```text
Tool calls/day:          10 + 20 + 60 + 10 = 100
GitHub REST calls/day:   10×5 + 20×27 + 60×3 + 10×4 = 810
GitHub calls/30 days:    810×30 = 24,300
New commits/day:         10
```

This repository traffic is below the normal 5,000/hour allowance even if those calls fall in one hour, assuming no competing account activity. Secondary limits still apply. Worker traffic includes these 100 tool requests plus protocol/authentication requests; GitHub sign-in and setup traffic are also outside the estimate.

The deployment costs $0 on the Free plans only while actual CPU time, all request/operation quotas, and storage remain within their allowances. On Workers Paid, usage within all included meters costs the $5 monthly minimum. This estimate supplies no CPU measurement or fixed OAuth KV total, so it cannot establish either bill. Large notes, repeated full scans, other account workloads, and client reconnects change the result. Client subscriptions and model charges remain your own, outside OwnContext.

[workers-pricing]: https://developers.cloudflare.com/workers/platform/pricing/
[workers-limits]: https://developers.cloudflare.com/workers/platform/limits/
[kv-pricing]: https://developers.cloudflare.com/kv/platform/pricing/
[kv-limits]: https://developers.cloudflare.com/kv/platform/limits/
[github-plans]: https://docs.github.com/en/get-started/learning-about-github/githubs-plans
[github-limits]: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
[github-contents]: https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents
