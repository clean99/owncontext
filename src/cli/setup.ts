import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readTemplate } from './demo';
import { commandRunner, prompt, readJson, writeJson, type CommandRunner, type CommandResult } from './io';
import { buildPlan, clientSnippets, deploymentFingerprint, fingerprint, SECRET_NAMES, validateSetup, workerConfig,
  type Observation, type SecretName, type SetupConfig, type SetupState } from './setup-plan';

export const DATA_FLOW = `Your MCP client → your Cloudflare Worker → your private GitHub Markdown repository.
GitHub sign-in identifies the single allowed account; a separate fine-grained GitHub token lets the Worker read/write that repository.
Give that token access only to the selected repository: Contents read/write and Metadata read.
Secrets go to Wrangler over stdin, never into config files or printed output. Notes and corrections remain in private Git history.
No model calls, embeddings, automatic capture, or billing setup. Cloudflare/GitHub limits and charges still apply.
Setup never changes repository visibility, account permissions, or existing template files.`;

export function prerequisiteIssue(name: string, result: CommandResult): string | undefined {
  if (result.code !== 0) return `Install ${name} and ensure it is on PATH, then run setup --resume.`;
  if (name === 'node') {
    const match = result.stdout.trim().match(/^v(\d+)\.(\d+)\.(\d+)/);
    if (!match || Number(match[1]) < 24 || (Number(match[1]) === 24 && Number(match[2]) < 11))
      return 'Node 24.11 or newer is required. Activate Node 24 LTS and retry.';
  }
}

function success(result: CommandResult, action: string): string {
  if (result.code !== 0) throw new Error(`${action} failed. Check authentication and permissions, then run npm run setup -- --resume. External output was withheld to protect secrets.`);
  return result.stdout;
}
function json<T>(result: CommandResult, action: string): T {
  try { return JSON.parse(success(result, action)) as T; }
  catch { throw new Error(`${action} failed or returned unexpected data. Check the CLI version and account access, then resume.`); }
}

export async function sourceFingerprint(root: string): Promise<string> {
  const source = await readTemplate(join(root, 'src'));
  const template = await readTemplate(join(root, 'templates/knowledge'));
  return fingerprint([Object.entries(source).sort(), Object.entries(template).sort(), await readFile(join(root, 'package-lock.json'), 'utf8')]);
}

export interface SetupDependencies {
  run: CommandRunner;
  secrets: Partial<Record<SecretName, string>>;
  askSecret: (name: SecretName) => Promise<string>;
  confirm: (steps: string[]) => Promise<boolean>;
  log: (message: string) => void;
}

export async function executeSetup(root: string, config: SetupConfig, dependencies: SetupDependencies) {
  config = validateSetup(config);
  const { run, log } = dependencies;
  const statePath = join(root, '.owncontext/setup.json');
  const configPath = join(root, '.owncontext/wrangler.json');
  const bootstrapPath = join(root, '.owncontext/bootstrap.json');
  const previous = await readJson<SetupState>(statePath);
  if (previous && (previous.config.accountId !== config.accountId || previous.config.worker !== config.worker
    || previous.config.owner !== config.owner || previous.config.repo !== config.repo))
    throw new Error('Saved setup targets a different repository or Worker. Use a separate checkout instead of reusing its state.');
  await writeJson(statePath, { config, deployedFingerprint: previous?.deployedFingerprint });
  const gh = (args: string[], input?: string) => run('gh', ['api', '--hostname', 'github.com', ...args], { input });
  const wrangler = (args: string[], bootstrap = false, input?: string) => run('wrangler', [...args, '--config', bootstrap ? bootstrapPath : configPath],
    { input, env: { CLOUDFLARE_ACCOUNT_ID: config.accountId } });
  for (const name of ['node', 'git', 'gh', 'wrangler']) {
    const issue = prerequisiteIssue(name, await run(name, ['--version']));
    if (issue) throw new Error(issue);
  }
  success(await run('gh', ['auth', 'status', '--hostname', 'github.com']), 'GitHub authentication (run gh auth login)');
  await writeJson(bootstrapPath, { name: config.worker, account_id: config.accountId });
  success(await wrangler(['whoami'], true), 'Cloudflare authentication (run wrangler login)');
  const template = await readTemplate(join(root, 'templates/knowledge'));
  const repoPath = `repos/${config.owner}/${config.repo}`;
  const repositoryResult = await gh([repoPath]);
  const missing = repositoryResult.code !== 0 && /HTTP 404/.test(repositoryResult.stderr);
  const repository = missing ? null : json<{ private: boolean; default_branch: string; size: number }>(repositoryResult, 'Inspect repository');
  let files: string[] = [];
  if (repository) {
    const result = await gh([`${repoPath}/git/trees/${encodeURIComponent(repository.default_branch)}?recursive=1`]);
    if (!(result.code !== 0 && /HTTP 409/.test(result.stderr) && repository.size === 0)) {
      const tree = json<{ tree: { path: string }[]; truncated: boolean }>(result, 'List repository files');
      if (tree.truncated) throw new Error('Repository tree is truncated. Choose a smaller knowledge repository.');
      files = tree.tree.map(file => file.path);
    }
  }
  const title = `${config.worker}-oauth`;
  async function namespace() {
    const namespaces = json<{ id: string; title: string }[]>(await wrangler(['kv', 'namespace', 'list'], true), 'List OAuth KV namespaces');
    const matches = namespaces.filter(entry => entry.title === title);
    if (matches.length > 1) throw new Error('Multiple matching OAuth KV namespaces. Resolve the naming collision before resuming.');
    return matches[0]?.id;
  }
  const namespaceId = await namespace();
  const secretResult = await wrangler(['secret', 'list', '--format', 'json'], true);
  const workerMissing = secretResult.code !== 0 && /Worker [\s\S]*not found|code: 10007/i.test(secretResult.stderr + secretResult.stdout);
  const secretNames = workerMissing ? [] : json<{ name: string }[]>(secretResult, 'List Worker secrets').map(secret => secret.name);
  const observed: Observation = { repoExists: !!repository, repoPrivate: repository?.private ?? true, files, namespaceId, secrets: secretNames };
  const buildId = deploymentFingerprint(config, await sourceFingerprint(root));
  const desiredFingerprint = buildId;
  const currentConfig = await readJson<Record<string, unknown>>(configPath) ?? {};
  const desiredConfig = workerConfig(config, namespaceId ?? '', buildId);
  const supplied = SECRET_NAMES.filter(name => !!dependencies.secrets[name]);
  const steps = buildPlan(config, observed, Object.keys(template), currentConfig, desiredConfig,
    previous?.deployedFingerprint, desiredFingerprint, supplied);
  if (!steps.length) { log('Already configured; no writes or deployment needed.'); return { changed: false, buildId }; }
  if (!await dependencies.confirm(steps)) throw new Error('Setup cancelled; no remote changes made.');
  const state: SetupState = { config, deployedFingerprint: previous?.deployedFingerprint };
  if (steps.includes('deploy')) delete state.deployedFingerprint;
  await writeJson(statePath, state);
  const secrets: Partial<Record<SecretName, string>> = {};
  for (const name of SECRET_NAMES) {
    if (!secretNames.includes(name) || dependencies.secrets[name]) {
      const value = dependencies.secrets[name] ?? await dependencies.askSecret(name);
      if (!value || value !== value.trim() || /[\r\n\0]/.test(value)) throw new Error(`${name} is missing or malformed. Supply it privately and resume.`);
      secrets[name] = value;
    }
  }
  if (steps.includes('create-repo')) success(await run('gh', ['repo', 'create', `${config.owner}/${config.repo}`, '--private']), 'Create private repository');
  if (steps.includes('seed-template')) {
    for (const [path, text] of Object.entries(template)) {
      if (files.includes(path)) continue;
      const endpoint = `${repoPath}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
      const existing = await gh([endpoint]);
      if (existing.code === 0) continue;
      if (!/HTTP 404/.test(existing.stderr)) success(existing, 'Check template path');
      success(await gh([endpoint, '--method', 'PUT', '--input', '-'], JSON.stringify({
        message: 'chore: initialize synthetic knowledge template', content: Buffer.from(text).toString('base64'),
      })), 'Seed missing template file');
    }
  }
  let resolvedNamespace = namespaceId;
  if (steps.includes('create-kv')) {
    success(await wrangler(['kv', 'namespace', 'create', title, '--update-config=false'], true), 'Create OAuth KV namespace');
    resolvedNamespace = await namespace();
  }
  if (!resolvedNamespace || !/^[a-f0-9]{32}$/.test(resolvedNamespace)) throw new Error('OAuth KV namespace was not resolved. Check the account and resume.');
  await writeJson(configPath, workerConfig(config, resolvedNamespace, buildId));
  if (workerMissing) success(await wrangler(['deploy']), 'Create Worker (requests remain unavailable until secrets are installed)');
  if (Object.keys(secrets).length) {
    success(await wrangler(['secret', 'bulk'], false, JSON.stringify(secrets)), 'Install Worker secrets');
    const installed = json<{ name: string }[]>(await wrangler(['secret', 'list', '--format', 'json']), 'Verify Worker secrets');
    if (SECRET_NAMES.some(name => !installed.some(secret => secret.name === name))) throw new Error('Worker secrets are incomplete; resume setup.');
  }
  if (steps.includes('deploy')) {
    success(await wrangler(['deploy']), 'Deploy Worker');
    state.deployedFingerprint = desiredFingerprint;
    await writeJson(statePath, state);
  }
  log('Setup complete. Run npm run doctor to verify the endpoint and repository access.');
  return { changed: true, buildId };
}

export async function main(root: string, args: string[] = process.argv.slice(2)) {
  if (args.some(arg => !['--dry-run', '--resume', '--help'].includes(arg))) throw new Error('Usage: npm run setup -- [--dry-run] [--resume]');
  console.log(DATA_FLOW);
  if (args.includes('--help')) { console.log('Usage: npm run setup -- [--dry-run] [--resume]\nState: .owncontext/setup.json (no secrets). --resume re-checks remote state and skips completed work.'); return; }
  const previous = await readJson<SetupState>(join(root, '.owncontext/setup.json'));
  if (args.includes('--dry-run')) {
    console.log('DRY RUN: no account commands, prompts, configuration writes or network access.');
    console.log('Plan: check node/git/gh/wrangler → authenticate → inspect/create private repo → seed missing template files → reuse/create OAuth KV → configure vars/secrets → deploy if changed.');
    console.log('Requires a GitHub OAuth App: homepage = Worker origin; authorization callback = Worker origin + /callback. Create it manually at https://github.com/settings/developers.');
    console.log(previous ? 'Saved configuration found; --resume will reconcile it with remote state.' : 'No saved setup; live setup will ask for repository, account, Worker origin, OAuth App and allowed identity.');
    console.log(clientSnippets(previous?.config.origin ?? 'https://owncontext.example').join('\n'));
    return;
  }
  if (args.includes('--resume') && !previous) throw new Error('Nothing to resume. Run npm run setup to configure a new installation.');
  const ui = prompt();
  try {
    let config = previous?.config;
    if (!args.includes('--resume')) {
      config = validateSetup({
        owner: await ui.ask('GitHub repository owner', config?.owner), repo: await ui.ask('Private knowledge repository name', config?.repo ?? 'owncontext-notes'),
        createRepo: (await ui.ask('Create the repository if missing? yes/no', config?.createRepo ? 'yes' : 'no')) === 'yes',
        login: await ui.ask('Allowed GitHub login', config?.login), githubId: await ui.ask('Allowed numeric GitHub ID (gh api user --jq .id)', config?.githubId),
        accountId: await ui.ask('Cloudflare account ID', config?.accountId), worker: await ui.ask('Worker name', config?.worker ?? 'owncontext'),
        origin: await ui.ask('Worker HTTPS origin (https://WORKER.SUBDOMAIN.workers.dev)', config?.origin),
        clientId: await ui.ask('GitHub OAuth App client ID (create app with callback ORIGIN/callback)', config?.clientId),
        timeZone: await ui.ask('IANA time zone', config?.timeZone ?? 'UTC'), locale: await ui.ask('Locale en/zh', config?.locale ?? 'en'),
      });
    }
    config = validateSetup(config);
    await executeSetup(root, config, { run: commandRunner(root), log: console.log,
      secrets: Object.fromEntries(SECRET_NAMES.filter(name => process.env[name]).map(name => [name, process.env[name]])),
      askSecret: name => ui.ask(name, '', true),
      confirm: async steps => {
        console.log(`Target: ${config.owner}/${config.repo}; Worker ${config.worker}; ${config.origin}`);
        console.log(`OAuth App callback must be ${config.origin}/callback. Planned changes: ${steps.join(', ')}.`);
        return await ui.ask('Type deploy to allow these GitHub/Cloudflare changes') === 'deploy';
      },
    });
    console.log(clientSnippets(config.origin).join('\n'));
  } finally { ui.close(); }
}
