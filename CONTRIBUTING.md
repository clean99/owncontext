# Contributing

OwnContext is a single-user context server. Keep changes focused on portable text, traceable sources, safe correction, and explicit user-selected capture. Discuss new storage adapters or a broader product scope before implementing them.

## Local development

Use Node.js 24.11+ and the public npm registry:

```sh
npm ci --registry=https://registry.npmjs.org
npm run demo
npm run lint
npm run typecheck
npm test
npm run check:release
npm run build
```

`lint` includes TypeScript checking and ESLint. Tests use synthetic fixtures and fake GitHub/KV; they do not need accounts. `build` clears old `dist/` output, creates an ignored `.cache/build/wrangler.json` with a synthetic KV ID, and runs Wrangler `deploy --dry-run`. Wrangler's esbuild wrapper forces an absolute `sourceRoot`; the build converts its maps to relative `sources` with an empty `sourceRoot` and removes `sourcesContent` before retaining the bundle in `dist/worker/`. Intermediate bundles are removed, and a failed artifact check removes `dist/`. The root config stays unchanged. CI also runs `npm run check:build` to reject filesystem paths and embedded source text in distribution artifacts. `dist/`, `.cache/`, `.wrangler/`, and `coverage/` are Git-ignored and excluded by the package's source-only file allowlist; npm publication remains disabled by `private: true`. A successful build verifies packaging, not live account permissions or OAuth behavior.

Real setup and doctor acceptance have external effects. Use only your own accounts and explicitly selected synthetic data when validating them. Do not include credentials or personal repository state in a patch.

## Change guidelines

- Match the existing TypeScript style. Keep validation and business logic separate from transport or prompts.
- Add behavior tests that fail if the behavior is removed. Cover stale SHA, repeat requests, scope checks, and path restrictions when changing writes.
- Preserve `stated` versus `inferred`, source references, and occurrence dates. Do not turn an assistant suggestion into a user fact or silently add background capture.
- Update English and Chinese documentation together when changing commands, permissions, storage, or supported behavior. Label untested client integrations honestly.
- Use public example domains and synthetic fixtures. Do not copy private notes, internal service names, company code, access logs, or real credentials into this tree.
- Explain the change, its verification, and any limitations in the pull request. Keep commits focused with conventional messages such as `fix: reject stale note updates`.

## Release hygiene

`scripts/check-release.mjs` scans tracked files plus non-ignored untracked files, including names and contents. It also scans staged contents, so an old sensitive version cannot remain hidden in the index. Generated files and local secrets ignored by Git are outside its scope unless tracked. It rejects non-placeholder email addresses, common credential formats, credential assignments, non-public registry settings, internal host/path markers, and any private identifiers supplied for that run. Symlinks are rejected rather than followed outside the source tree. Diagnostics report locations and rule names, not matching secret values.

Supply project-specific identifiers through `OWNCONTEXT_PRIVATE_MARKERS`, a JSON array of non-empty strings, from a private local environment or CI secret. The scanner hashes them in memory and redacts matching filenames. The public source contains no real identifier list or digests; without the variable, only generic rules run. Invalid JSON or entries fail the check. Never commit the identifier list, including hashes of low-entropy names.

Only reserved example domains are accepted for email examples. Source dependencies must resolve through `https://registry.npmjs.org`. The scanner is a local guard, not a general PII detector: it cannot recognize every name, secret format, encoded value, or historical commit. Inspect the final diff and entire history before publication. Do not bypass findings by weakening rules or encoding sensitive material.

Before public release, enable GitHub private vulnerability reporting, verify the report entry point, and complete live OAuth/client acceptance. Add the 30-second recording only after it exists and contains synthetic data. CI contains no publishing or deployment step.

`npm run benchmark` prints the method and raw latency samples for 100-file and 1,000-file synthetic Markdown repositories using the demo's in-memory GitHub substitute. [Recorded samples](docs/benchmarks.json) measure local read, paginated search, full search and SHA-checked save operations. They exclude real network, OAuth and Worker execution; use a deployment to measure production latency and platform quotas.

The `undici` override pins the patched 7.30.1 HTTP dependency used by local tooling; keep it until the bundled Miniflare version resolves a patched release without an override. Check `npm audit` when updating dependencies.

## Issues and conduct

Use the issue templates for sanitized bug reports and focused proposals. Security findings belong in the private channel described in [SECURITY](SECURITY.md). Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Contributions are submitted under [Apache-2.0](LICENSE). Dependencies retain their own licenses.
