# Recovery and uninstall

[Home](../../README.md) · [简体中文](../zh/recovery-and-uninstall.md)

## Diagnose before changing resources

`npm run doctor -- --dry-run` is offline. `npm run doctor` contacts the saved Worker origin and is read-only. Supply an OwnContext OAuth access token privately for repository checks. The `--acceptance` option writes a synthetic note and is deliberately separate.

| Symptom | Action |
| --- | --- |
| Setup interrupted | Keep `.owncontext/setup.json` and run `npm run setup -- --resume`; it rechecks remote state before applying missing steps |
| Invalid local JSON | Repair the saved non-secret configuration; do not replace secrets with public examples |
| Public or inaccessible repository | Select a private repository and verify the repository token's owner, target, permissions, and expiry |
| Missing required context | Resume can add absent template files; inspect existing `AGENTS.md` and profile cards directly if their contents or sizes are incompatible |
| Wrong allowed identity | Check both GitHub login and numeric ID, and the OAuth App callback origin |
| Extra GitHub OAuth scopes | Revoke the old GitHub OAuth App authorization, then reconnect with identity-only sign-in |
| Missing write scope | Reconnect to OwnContext and explicitly select the separate write checkbox |
| Expired client token | Reauthenticate or refresh through the client; doctor does not perform browser sign-in |
| Old build | Review local changes and run setup/resume to deploy them; check that the origin points to the intended Worker |
| `note_changed_read_and_merge` | Read the current file and SHA, merge the correction, then retry; never force a stale replacement |
| `index_changed_restart_search` | Restart the paginated search or index request |

Resume is a live operation, not a rollback or no-side-effect check. It may deploy and resets manually configured optional tools to the setup defaults. The saved build fingerprint is not a cryptographic attestation of remote configuration.

## Rotate credentials

For a repository token compromise, revoke the old fine-grained token in GitHub immediately. Create a replacement restricted to the same notes repository. For an OAuth App secret compromise, regenerate that secret in GitHub. Replacing either Worker secret does **not** revoke already-issued OwnContext OAuth grants.

Install replacements with Wrangler's hidden prompt, targeting the generated configuration:

```sh
npx --no-install wrangler secret put OWNCONTEXT_GITHUB_TOKEN --config .owncontext/wrangler.json
npx --no-install wrangler secret put GITHUB_CLIENT_SECRET --config .owncontext/wrangler.json
```

Run only the command for the secret you are rotating. Alternatively supply the replacement privately in the corresponding environment variable and run setup/resume; setup detects a supplied secret as a rotation request. Existing secret names alone do not tell setup that a value expired.

## Revoke clients

Removing a connector from a client may only remove its local configuration. The provider exposes OAuth revocation through the `revocation_endpoint` in its metadata, currently `/oauth/token`. A client must authenticate as the client that owns the token. Revoking an access token revokes that token; revoking its refresh token revokes the associated grant. Use your client's revocation feature if available; there is no OwnContext grant-management UI.

For an emergency stop, disable or remove the Worker and its routes in your Cloudflare account first. To invalidate all client sessions before restoring service, remove the records from the **dedicated OwnContext OAuth KV namespace**, or replace that namespace and bind the new one. This removes registrations and grants, so every client must reconnect. Never clear a namespace shared with another application. KV changes can take time to propagate; keep the Worker unavailable while containment matters. Check the namespace binding before any resumed setup, which reconciles by the expected namespace name.

Revoking GitHub OAuth App authorization prevents that upstream authorization from being reused; it is not a substitute for revoking OwnContext grants. Rotate or revoke the repository token too if it was exposed.

## Recover a note

Inspect the file's Git history in your private repository. Restore or merge the desired revision through GitHub or Git, preserving any valid newer edits. A normal revert records another commit; it does not remove the earlier version from history. MCP deliberately provides no deletion or force-write tool.

If sensitive data was saved, remove it from the current note, revoke any exposed credentials, and follow GitHub's [sensitive-data removal procedure](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository). Account for clones, backups, and client conversation history separately. A force-push alone cannot erase copies held elsewhere.

## Uninstall in your own accounts

1. Remove the connector from every client and revoke its grants, or stop the Worker and invalidate all OAuth KV state as above.
2. Remove the OwnContext Worker, associated routes/custom domains, and its dedicated OAuth KV namespace in Cloudflare. Check that no unrelated application uses those resources.
3. Revoke the fine-grained repository token and the GitHub OAuth App authorization; delete the App if it is dedicated to this installation.
4. Keep or delete the private notes repository according to your retention needs. Deletion does not erase existing clones, backups, or client/provider records.
5. Remove the source checkout and its local `.owncontext/`, `.cache/`, `.wrangler/`, secret files, and environment variables when no longer needed. Shared `gh`/Wrangler account logins are independent of this project; retain them if other projects use them.

There is no automatic uninstall command. Destructive actions belong to the account owner and should be performed only after checking names and backups.
