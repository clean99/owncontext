# Quickstart

[Home](../../README.md) · [简体中文](../zh/quickstart.md)

## Run the offline demo

Use Node.js 24.11 or newer and npm in the source checkout:

```sh
node --version
npm ci --registry=https://registry.npmjs.org
npm run demo
npm run setup -- --dry-run
```

Dependency installation downloads public packages. The demo itself uses only `templates/knowledge/` and an in-memory GitHub substitute. It saves a synthetic preference, repeats the save without another write, reads it with a second tool client, corrects it, and rejects a stale edit. A unified Markdown diff is printed. No OAuth, deployed Worker, or real AI client participates in this demo.

The setup preview prints the deployment plan without prompts, account commands, network access, or configuration writes.

## Prepare your accounts

Live setup has remote side effects. Review [privacy](privacy-and-data-flow.md) and [permissions](permissions-and-scopes.md) first.

1. Install Git and the [GitHub CLI](https://cli.github.com/). Wrangler is installed with this project's npm dependencies. Check `git --version`, `gh --version`, and `npx --no-install wrangler --version`.
2. Authenticate your own accounts with `gh auth login --hostname github.com` and `npx --no-install wrangler login`. Setup inspects existing authentication; it does not run those login commands for you.
3. Choose a private GitHub notes repository, separate from this source checkout. For least-privilege setup, create the private repository first. Although setup can create a repository, it asks for the repository token before creating resources; a token restricted to that repository requires the repository to exist. Setup never changes visibility.
4. Create a fine-grained GitHub token restricted to that repository, with **Contents: read and write** and **Metadata: read**. This is the Worker's repository token, independent of `gh`'s local login.
5. Choose a Worker name, Cloudflare account ID, and HTTPS origin, for example `https://owncontext.YOUR-SUBDOMAIN.workers.dev`. The Workers subdomain must already be available in your account. Custom-domain provisioning is outside setup.
6. Create a [GitHub OAuth App](https://github.com/settings/developers) with that origin as its homepage and `https://owncontext.YOUR-SUBDOMAIN.workers.dev/callback` as its authorization callback. Keep its client ID and secret. Sign-in requests no GitHub scopes.
7. Record the allowed GitHub login and numeric ID from `gh api --hostname github.com user --jq '{login, id}'`. Both are checked. Choose an IANA time zone such as `UTC` and a locale, `en` or `zh`.

Enter secrets through setup's hidden prompts. Avoid putting them into shell commands, screenshots, issue reports, or source files. `GITHUB_CLIENT_SECRET` and `OWNCONTEXT_GITHUB_TOKEN` can also be supplied through environment variables by a secret manager; they are passed to Wrangler over stdin.

## Deploy deliberately

```sh
npm run setup
```

The interactive wizard records non-secret state in ignored `.owncontext/` files, checks tools and account access, inspects the repository and Cloudflare resources, then lists the proposed changes. Type `deploy` only after checking the target repository, Worker, and origin.

Setup adds only absent files from `templates/knowledge/`. It does not replace existing notes or automatically rewrite an incompatible layout. Required context files are `AGENTS.md`, `me/profile.md`, `me/preferences.md`, and `me/values.md`. Replace the synthetic examples with your own selected information directly in your private repository.

A new Worker may first be published without secrets; requests remain unavailable until secrets are installed and setup completes. Resume interrupted setup with:

```sh
npm run setup -- --resume
```

Resume rechecks remote resources and skips completed work. It is not a dry run. Keep the same repository, account, and Worker for this checkout; use another checkout for a different installation. Generated config is `.owncontext/wrangler.json`. Bare `npm run deploy` uses the unconfigured root template, not this generated deployment.

## Connect a client

Setup prints the actual endpoint. For Claude Code:

```sh
claude mcp add --transport http owncontext https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp
```

Open Claude Code's MCP connection controls and complete browser authentication. For claude.ai, use **Settings → Connectors → Add custom connector** and enter the same `/mcp` URL. Availability depends on the client's plan, policy, and version. These are configuration recipes; live acceptance in those clients is still pending.

Check the client and redirect destination on OwnContext's consent page. Sign in with the configured GitHub account. Read-only access is the default; select the separate `owncontext:write` checkbox only for a client you trust to modify notes. The server does not ask for approval on each subsequent write.

Ask the client to call `get_context`, search a topic, and `read` the selected result. Ask for citations to the full source note; brief cards are shortened and can omit references. For a correction, read the current note and SHA, merge the new statement with valid existing information, then call `update_note`. If it conflicts, read and merge again.

## Check a deployed instance

```sh
npm run doctor -- --dry-run
npm run doctor
```

The first command is an offline preview. The second makes requests to the saved origin. It checks `/health` and the local source/config build fingerprint. Repository checks require `OWNCONTEXT_ACCESS_TOKEN`, an **OwnContext-issued OAuth access token**, supplied privately from an authorized client or OAuth test client. Doctor does not sign you in or extract client tokens. Without it, health can pass while doctor exits with a missing-token diagnostic.

`OWNCONTEXT_URL` can override the origin. A manually configured installation without setup state also needs `OWNCONTEXT_BUILD_ID` set to its expected build fingerprint.

For an explicitly authorized, write-enabled acceptance run:

```sh
npm run doctor -- --acceptance
```

This connects two MCP SDK clients and writes a unique synthetic `topics/owncontext-acceptance-<id>.md` note. It requires the unchanged `raw/snippets/preferences.md` synthetic source file. Successful writes remain in Git history, even if a later step fails. The default doctor is read-only; acceptance is not.

## Enable optional tools

`capture_conversation`, `log_decision`, and `log_meal` are off by default. After setup, an operator can set `vars.ENABLED_TOOLS` in `.owncontext/wrangler.json` to the comma-separated tool names and deploy that config explicitly:

```sh
npx --no-install wrangler deploy --config .owncontext/wrangler.json
```

This is a real deployment. Setup currently regenerates `ENABLED_TOOLS` as an empty string, so a later setup/resume will reset this customization. The build fingerprint does not attest to manual config changes. Recheck enabled tools after deployment. Every optional tool still requires OAuth write consent. Capture has no automatic redaction; select and scrub snippets before sending them.
