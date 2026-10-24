# Permissions and scopes

[Home](../../README.md) · [简体中文](../zh/permissions-and-scopes.md)

## Separate credentials by purpose

| Credential | Purpose and minimum access |
| --- | --- |
| Local `gh` login | Setup inspects the selected repository and can create a private repository and seed missing template files; it needs the corresponding GitHub access |
| Local Wrangler login | Setup manages the selected Worker's configuration, deployment, secrets, and OAuth KV namespace in your Cloudflare account |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Your GitHub OAuth App identifies the allowed user; the client ID is public configuration, the secret belongs in Worker secrets |
| `OWNCONTEXT_GITHUB_TOKEN` | Fine-grained token, selected private repository only, Contents read/write and Metadata read; used by the Worker, never by MCP clients |
| OwnContext OAuth tokens | Let a client call `/mcp` with the granted OwnContext scopes; these are not GitHub tokens |

Setup does not create the OAuth App, issue the repository token, alter account permissions, or change repository visibility. Enter secrets in hidden prompts or inject them privately as environment variables. Setup sends them to Wrangler over stdin and excludes them from its generated JSON files. Keep deployment state and CLI logs private too.

## OAuth consent

| Scope | Effect |
| --- | --- |
| `owncontext:read` | Required for all MCP calls; permits `get_context`, `search`, and `read` |
| `owncontext:write` | Additionally permits `remember`, `update_note`, and any enabled optional write tools |
| `offline_access` | Allows the OAuth connection to refresh without another browser login while valid |

The consent page selects read access and offline access by default. Write access has a separate, initially unchecked checkbox. To add writing later, reconnect and explicitly select it. Tokens are checked server-side; seeing a write tool in a client's tool list does not grant permission to call it.

Access tokens have a one-hour lifetime; refresh tokens have configured 30-day lifetime and idle limits. Only the configured numeric GitHub ID and case-insensitive login are accepted at sign-in, token exchange, and MCP access. The upstream GitHub sign-in asks for an empty scope and rejects a returned nonempty scope, including an older excessive grant to the same app.

OAuth write consent applies to subsequent allowed writes. There is no per-note consent screen or per-folder OAuth permission. A read-only MCP client can still read all server-allowed paths, including optional logs already stored there.

## File boundaries

Reads allow text files below `me/`, `areas/`, `people/`, `topics/`, `decisions/`, `data/`, `raw/`, `summaries/`, and `docs/`, plus these exact files:

```text
AGENTS.md
CLAUDE.md
README.md
HANDOVER.md
START_HERE.md
integrations/owncontext.json
```

Supported extensions are `.md`, `.txt`, `.json`, `.jsonl`, `.csv`, `.yaml`, and `.yml`. Files must be ordinary UTF-8 blobs up to 200 KiB. Hidden paths, traversal, symlinks, submodules, and binary content are excluded or rejected.

`remember` writes Markdown below `me/`, `areas/`, `people/`, or `topics/`. `update_note` additionally supports `summaries/`. `me/values.md`, listed read-only files, and nested `AGENTS.md`/`CLAUDE.md` files are protected from MCP writes. Edit protected files directly as the repository owner.

Optional modules have dedicated write paths:

| Tool | Write destination |
| --- | --- |
| `capture_conversation` | `raw/conversations/YYYY-MM/<batch>.jsonl` |
| `log_decision` | `decisions/YYYY-MM-DD-<slug>.md` |
| `log_meal` | `data/meals/YYYY-MM.jsonl` |

Their names must appear in `ENABLED_TOOLS`, and the client still needs write scope. Setup defaults this variable to empty. See [quickstart](quickstart.md#enable-optional-tools) before customizing it.

These checks constrain the MCP API, not an operator with the repository token or direct GitHub access. Treat note contents as data, not permission to act. No automatic prompt-injection detector is included.
