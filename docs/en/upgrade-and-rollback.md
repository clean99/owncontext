# Upgrade and rollback

[Home](../../README.md) · [简体中文](../zh/upgrade-and-rollback.md)

Use this procedure for an existing installation. First-time deployment is covered by [quickstart](quickstart.md). Deploy and rollback commands below change your live Worker. The examples assume setup generated `.owncontext/wrangler.json` in the source checkout.

Commands were checked against the project's **Wrangler 4.149.0** help and the official Cloudflare pages listed below on **2026-10-25**. Live deployment and rollback are separate acceptance work; local checks do not establish that they succeeded in your account.

## Record the working deployment

Use Node.js 24.11+ and the same GitHub and Cloudflare accounts as the installation. Before changing source:

```sh
git status --short
git rev-parse HEAD
npx --no-install wrangler deployments status --config .owncontext/wrangler.json
npx --no-install wrangler versions list --config .owncontext/wrangler.json
```

Keep the source commit and the active, known-good **Worker version ID** in a private operator record. `versions list` includes uploaded versions that may never have served traffic; use `deployments status` to identify the live version. The Worker version ID is distinct from OwnContext's `BUILD_ID` fingerprint and the Git commit SHA.

Back up `.owncontext/` privately outside the checkout before setup rewrites it. Preserve the actual deployment configuration, including any optional tools or manual settings, and record the current `/health` build fingerprint. Keep working-tree changes separately before switching refs. These backups contain account identifiers and belong outside the public source repository.

Review the target release's migration and compatibility instructions. Keep a private backup or clone of the notes repository, including history. A Worker rollback leaves that repository and OAuth KV data at their current state. Keep the existing KV namespace and valid credentials available.

## Upgrade the existing installation

Obtain the reviewed release tag or commit from the source distributor. Replace `YOUR_RELEASE_REF` below with that actual ref; this guide does not assume a release tag exists or prescribe its name. If your checkout uses `origin` for the source repository:

```sh
git fetch --tags origin
git switch --detach YOUR_RELEASE_REF
npm ci --registry=https://registry.npmjs.org
npm run lint
npm run typecheck
npm test
npm run check:release
npm run build
npm run setup -- --dry-run
```

`build` is a local Wrangler dry-run with a synthetic KV ID. `setup --dry-run` prints an offline plan, not a comparison with your live deployment.

For a setup-managed installation using the generated defaults:

```sh
npm run setup -- --resume
```

Review the proposed changes and type `deploy` only for the intended account, repository, Worker, and origin. Resume rechecks remote resources, regenerates the config and `BUILD_ID`, and deploys when its plan requires it. It can also seed newly missing template files or recreate missing resources. Existing template files and notes are preserved. Missing resources or an unexpected target are reasons to stop and inspect the plan rather than continue an upgrade blindly.

Setup/resume regenerates `ENABLED_TOOLS` as an empty string and replaces other manual edits to its generated config. For a customized installation, retain a private copy and review those differences **before** allowing setup to deploy. Pause affected clients if you accept an intermediate deployment with defaults. Then deliberately restore compatible custom settings to the newly generated config and deploy it explicitly:

```sh
npm run deploy -- --config .owncontext/wrangler.json
```

This script runs `wrangler deploy`; the equivalent is `npx --no-install wrangler deploy --config .owncontext/wrangler.json`. Bare `npm run deploy` instead selects the unconfigured root template. Reusing an old generated config without updating its fingerprint can publish new code with an old `BUILD_ID`, so it is not a substitute for the setup-managed upgrade above. Manual customizations are not covered by that fingerprint.

## Verify the new deployment

```sh
npx --no-install wrangler deployments status --config .owncontext/wrangler.json
npm run doctor -- --dry-run
npm run doctor
```

Supply `OWNCONTEXT_ACCESS_TOKEN` privately from an authorized client or OAuth test client. It must be an OwnContext-issued access token, not the repository token. Doctor checks `/health` against the expected source/config fingerprint, then calls `get_context` through authenticated MCP. A missing token means the repository check does not run and doctor exits unsuccessfully. `/health` alone checks configuration, not GitHub reachability.

Recheck an existing client connection, a fresh browser sign-in, and any customized optional tools. Doctor does not perform browser OAuth or verify manual config changes. To test writes and stale-SHA rejection, explicitly choose the separate `npm run doctor -- --acceptance` check; it writes a synthetic note and leaves commits in the private repository. See [quickstart](quickstart.md#check-a-deployed-instance) for its prerequisites. Record the new Worker version ID only after the checks you require pass.

## Roll back to the recorded version

Select the known-good version recorded before the upgrade. Replace `YOUR_GOOD_VERSION_ID` with its actual Worker version ID:

```sh
npx --no-install wrangler versions view YOUR_GOOD_VERSION_ID --config .owncontext/wrangler.json
npx --no-install wrangler rollback YOUR_GOOD_VERSION_ID --config .owncontext/wrangler.json
npx --no-install wrangler deployments status --config .owncontext/wrangler.json
```

Review Wrangler's prompts. An explicit ID avoids relying on its default version selection. Rollback immediately creates a deployment sending **100% of traffic** to that version on existing routes and domains. It does not change the local checkout. Cloudflare permits rollback within the latest 100 published versions; the referenced resources, including the target version's KV namespace, must still exist. Resource changes can block a rollback.

Cloudflare normally blocks deploying an older version when a secret has changed; Wrangler can ask for additional confirmation to continue. Treat that as a credential review, not a prompt to accept automatically. For a rotated or revoked credential, use a reviewed old source revision deployed with the current valid secrets and compatible configuration instead of overriding the rollback guard. Revoked GitHub credentials stay revoked in GitHub.

If the target is unavailable or incompatible with current data, retain the current state while choosing a compatible recovery revision. Deploying an old source revision with `npm run deploy -- --config .owncontext/wrangler.json` creates a **new** Worker version; it is a redeployment, not restoration of a stored version. Prepare that revision's matching config and `BUILD_ID`, preserve the intended KV binding, and review any migration instructions before publishing it.

## Check after rollback

For a rollback to the exact saved deployment:

- Switch the local source to its recorded Git commit, then run `npm ci --registry=https://registry.npmjs.org`.
- Restore the matching private `.owncontext/` backup in that checkout. Review its targets and manual settings before using it for any later deployment.
- Supply a valid OwnContext access token privately and run `npm run doctor` from the matching checkout. Recheck client access and the enabled tool set.

Doctor derives the expected fingerprint from local source, templates, lockfile, and saved setup config. Running it from the newer checkout after rollback can correctly report `stale-deploy`. Its suggestion to run setup/resume would deploy the newer code again; switch to the intended source first. Restoring only `deployedFingerprint` in local state does not change doctor's calculation.

For a manual installation without setup state, doctor instead accepts `OWNCONTEXT_URL` and `OWNCONTEXT_BUILD_ID`. Use the expected build recorded before deployment, not a value copied from an unexpected live response merely to make the check pass.

## Data and credentials across versions

| State | Upgrade or rollback behavior |
| --- | --- |
| GitHub notes and history | Stay in the private repository. Rolling back the Worker does not undo note writes; recover a note separately through Git history |
| OAuth KV | Registrations, grants, token records and flow state remain in the namespace. Rollback changes code/binding configuration, not KV contents |
| OwnContext client tokens | Can continue across compatible code changes with the same namespace, origin, allowed identity and scopes; normal expiry/revocation still applies |
| GitHub repository token and OAuth App secret | Ordinary code deployment preserves existing Worker secrets. Setup replaces missing secrets or explicitly supplied replacements; rollback across changed secrets has the guard described above |
| Local `.owncontext/` state | Setup updates it; remote rollback leaves it untouched |

The current code configures one-hour access tokens and 30-day refresh-token lifetime/idle limits. Neither a code rollback nor replacement of a GitHub secret revokes OwnContext grants. Replacing the KV namespace or changing identity/origin can require clients to reconnect. Keep KV formats compatible when changing the OAuth provider dependency; existing data is not automatically converted by a Worker rollback. The current project supplies no general data migration or rollback script.

For compromised credentials, grant revocation, note restoration, or uninstall, use [recovery and uninstall](recovery-and-uninstall.md). Avoid clearing OAuth KV as a routine upgrade step.

## Sources

Project behavior: [setup](../../src/cli/setup.ts), [configuration and fingerprints](../../src/cli/setup-plan.ts), [doctor](../../src/cli/doctor.ts), [OAuth lifetimes](../../src/index.ts), [package scripts](../../package.json). Read 2026-10-25.

Official Cloudflare documentation, read 2026-10-25:

- [Wrangler Worker commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/): deploy, versions, deployment status, and rollback syntax.
- [Versions and deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/): version snapshots and independent storage state.
- [Rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/): traffic switch, eligible versions, and resource constraints.
- [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/): secret changes and deployment behavior.
- [Create deployment API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/): the guard on rollback across changed secrets and its `force` override.
