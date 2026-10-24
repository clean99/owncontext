# Privacy and data flow

[Home](../../README.md) · [简体中文](../zh/privacy-and-data-flow.md)

## Where data goes

| Component | What it receives or stores |
| --- | --- |
| MCP client and its model provider | Requests, selected snippets, and returned context; retention follows that client's settings and terms |
| Your Cloudflare Worker | Decrypted tool requests and note contents while processing; GitHub repository token and OAuth App secret as Worker secrets |
| Workers KV | OAuth client registrations, grants, token records, and authorization-flow state managed by the OAuth provider library |
| Your private GitHub repository | Notes, optional raw snippets/logs, source references, commit metadata, and earlier revisions |
| Your local checkout | Setup targets and deployment fingerprints under ignored `.owncontext/`; CLI caches/logs under `.cache/` when run by setup |

The maintainer does not operate a storage relay. The runtime accesses GitHub.com for sign-in and repository operations. OAuth clients using Client ID Metadata Documents also cause the OAuth provider to fetch public client metadata. An MCP request can therefore involve infrastructure beyond GitHub and Cloudflare through the client itself.

OwnContext does not call a language model, create embeddings, run a scheduler, or install an automatic conversation hook. It has no application analytics endpoint. npm, GitHub CLI, Wrangler, and hosting platforms remain separate software with their own network and telemetry behavior. Setup disables Wrangler metrics for its child processes; the build script also disables them.

## Storage is private, not end-to-end encrypted

A private repository limits GitHub access. HTTPS protects transport. Cloudflare and GitHub still process plaintext, and connected clients receive readable content. OwnContext adds no application-level end-to-end encryption. Keep passwords, private keys, session cookies, and other credentials out of notes and selected snippets.

The Worker uses a separate fine-grained repository token; clients never need that token. GitHub OAuth sign-in requests no GitHub scopes and checks both the configured login and numeric ID. OwnContext issues its own scoped client tokens. See [permissions](permissions-and-scopes.md).

## Provenance and correction

`remember` stores the client-supplied `stated` or `inferred` label. A source reference and occurrence date are optional; absent references are explicitly labeled as client-reported. The service does not fetch or verify a source reference and cannot attest that a statement was made by the user.

The client must preserve sources, distinguish event time from the note's `updated` date, and keep superseded statements in a correction history when appropriate. `update_note` replaces the note body after a SHA check; it does not compose a correction or automatically retain every source. Whole-file correction is a write permission you should grant deliberately.

`remember` deduplicates by note path, fact text, and provenance label. Repeating the same fact with a different source or date will not update it. Use `update_note` to correct those fields. Keep the original fact marker in correction history to prevent a retry from adding the superseded fact again.

## Selected snippets

The optional `capture_conversation` tool accepts only `user` and `assistant` rows. It stores the supplied text verbatim as JSONL, marks coverage as partial, and performs **no redaction**. Tool guidance asks the client to submit only user-selected visible text. The server cannot independently verify selection or visibility: write-enabled clients must be trusted.

For retries, preserve `source`, `conversation_id`, `batch_id`, `captured_at`, and message content. Reusing a batch identifier for changed content within the same destination month is rejected. Changing the month can create a different file. This is batch idempotency, not global deduplication across unrelated batches or a complete conversation export.

## Logs and retention

Application tool logs contain only tool name and status code. Both shipped Worker configurations disable observability by default. Dependency, hosting, access, and CLI logs may contain additional request or account metadata; inspect your own settings before enabling or sharing logs. The release scanner does not inspect ignored local deployment state or caches unless they have been added to Git.

The release scanner ships generic checks only. To check project-specific identifiers, supply `OWNCONTEXT_PRIVATE_MARKERS` as a JSON array of non-empty strings through a private local environment or CI secret. Matching filenames are redacted; malformed configuration fails the check. Keep the list and its hashes out of published source.

Git history, clones, backups, client conversation history, and provider retention can retain previous content. Correcting or deleting a current file does not erase those copies. Removing a client connector does not necessarily revoke its server grant. Recovery, credential rotation, and deletion steps are in [recovery and uninstall](recovery-and-uninstall.md).
