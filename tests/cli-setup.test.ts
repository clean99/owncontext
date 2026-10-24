import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPlan, clientSnippets, configDiff, deploymentFingerprint, validateSetup, workerConfig, type SetupConfig } from '../src/cli/setup-plan';
import { executeSetup, main, prerequisiteIssue } from '../src/cli/setup';
import type { CommandRunner } from '../src/cli/io';

const config: SetupConfig = { owner: 'sample-user', repo: 'sample-notes', login: 'sample-user', githubId: '12345',
  accountId: 'a'.repeat(32), worker: 'owncontext', origin: 'https://owncontext.example', clientId: 'synthetic-client',
  timeZone: 'UTC', locale: 'en', createRepo: true };
const roots: string[] = [];
async function fixture() {
  await mkdir(join(process.cwd(), '.cache'), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), '.cache/setup-test-')); roots.push(root);
  await mkdir(join(root, 'templates/knowledge/me'), { recursive: true });
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'templates/knowledge/me/profile.md'), 'synthetic template');
  await writeFile(join(root, 'package-lock.json'), '{}');
  return root;
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function remote() {
  let repo = false; let worker = false; let kv = false; let failDeploy = false;
  const files = new Map<string, string>(); const secrets = new Set<string>();
  const calls: { command: string; args: string[]; input?: string }[] = [];
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, input: options?.input });
    const ok = (value: unknown = '') => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
    const missing = () => ({ code: 1, stdout: '', stderr: 'HTTP 404' });
    if (args[0] === '--version') return ok(command === 'node' ? 'v24.16.0' : '1.0');
    if (command === 'gh' && args[0] === 'auth') return ok();
    if (command === 'gh' && args[0] === 'repo') { repo = true; return ok(); }
    if (command === 'gh' && args[0] === 'api') {
      expect(args.slice(1, 3)).toEqual(['--hostname', 'github.com']);
      const endpoint = args[3];
      if (!repo) return missing();
      if (!endpoint.includes('/git/') && !endpoint.includes('/contents/')) return ok({ private: true, default_branch: 'main', size: files.size });
      if (endpoint.includes('/git/trees/')) return ok({ truncated: false, tree: [...files.keys()].map(path => ({ path })) });
      const path = endpoint.split('/contents/')[1];
      if (args.includes('PUT')) { files.set(path, JSON.parse(options!.input!).content); return ok({}); }
      return files.has(path) ? ok({}) : missing();
    }
    if (command === 'wrangler') {
      if (args[0] === 'whoami') return ok();
      if (args[0] === 'kv') {
        if (args[2] === 'create') { kv = true; return ok(); }
        return ok(kv ? [{ title: 'owncontext-oauth', id: 'b'.repeat(32) }] : []);
      }
      if (args[0] === 'secret') {
        if (!worker) return { code: 1, stdout: '', stderr: 'Worker "owncontext" not found.' };
        if (args[1] === 'bulk') { for (const key of Object.keys(JSON.parse(options!.input!))) secrets.add(key); return ok(); }
        return ok([...secrets].map(name => ({ name })));
      }
      if (args[0] === 'deploy') {
        if (failDeploy) return { code: 1, stdout: 'sensitive external output', stderr: 'synthetic-private-value' };
        worker = true; return ok();
      }
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  return { run, calls, files, secrets, failDeploy: () => { failDeploy = true; }, recover: () => { failDeploy = false; } };
}

function dependencies(run: CommandRunner) {
  return { run, secrets: {}, askSecret: vi.fn(async () => 'synthetic-private-value'), confirm: vi.fn(async () => true), log: vi.fn() };
}

describe('setup planning', () => {
  it('validates targets and generates only non-secret Worker vars', () => {
    expect(validateSetup(config).origin).toBe(config.origin);
    const generated = workerConfig(config, 'b'.repeat(32), 'build');
    expect(generated.vars).toMatchObject({ BUILD_ID: 'build', GITHUB_CLIENT_ID: 'synthetic-client', ENABLED_TOOLS: '' });
    expect(JSON.stringify(generated)).not.toContain('GITHUB_CLIENT_SECRET');
    expect(() => validateSetup({ ...config, origin: 'https://user:password@owncontext.example' })).toThrow();
    expect(() => validateSetup({ ...config, repo: '../notes' })).toThrow();
    expect(() => validateSetup({ ...config, accountId: 'bad' })).toThrow();
  });
  it('plans missing resources but skips a fully reconciled installation', () => {
    const observed = { repoExists: false, repoPrivate: true, files: [], secrets: [] };
    expect(buildPlan(config, observed, ['me/profile.md'], {}, { vars: {} }, undefined, 'new'))
      .toEqual(['create-repo', 'seed-template', 'create-kv', 'write-config', 'put-secrets', 'deploy']);
    expect(buildPlan(config, { ...observed, repoExists: true, namespaceId: 'id', files: ['me/profile.md'],
      secrets: ['GITHUB_CLIENT_SECRET', 'OWNCONTEXT_GITHUB_TOKEN'] }, ['me/profile.md'], {}, {}, 'same', 'same')).toEqual([]);
    expect(() => buildPlan(config, { ...observed, repoExists: true, repoPrivate: false }, [], {}, {}, '', '')).toThrow('private');
    expect(() => buildPlan({ ...config, createRepo: false }, observed, [], {}, {}, '', '')).toThrow('not found');
  });
  it('detects changed variables, removed config and explicitly supplied secret rotation', () => {
    expect(configDiff({ vars: { LOCALE: 'en' }, obsolete: true }, { vars: { LOCALE: 'zh' } })).toEqual(['obsolete', 'vars']);
    const observed = { repoExists: true, repoPrivate: true, files: [], namespaceId: 'id', secrets: ['GITHUB_CLIENT_SECRET', 'OWNCONTEXT_GITHUB_TOKEN'] };
    expect(buildPlan(config, observed, [], {}, {}, 'same', 'same', ['GITHUB_CLIENT_SECRET'])).toEqual(['put-secrets', 'deploy']);
    expect(buildPlan(config, observed, [], {}, {}, 'old', 'new')).toEqual(['deploy']);
    expect(deploymentFingerprint(config, 'source')).not.toBe(deploymentFingerprint({ ...config, repo: 'other-notes' }, 'source'));
    expect(deploymentFingerprint(config, 'source')).not.toBe(deploymentFingerprint(config, 'changed-source'));
  });
  it('reports prerequisite fixes and token-free client configuration', () => {
    expect(prerequisiteIssue('node', { code: 0, stdout: 'v24.10.0', stderr: '' })).toContain('24.11');
    expect(prerequisiteIssue('node', { code: 0, stdout: 'v24.11.0', stderr: '' })).toBeUndefined();
    expect(prerequisiteIssue('gh', { code: 127, stdout: '', stderr: '' })).toContain('Install gh');
    expect(clientSnippets(config.origin).join('\n')).toContain('claude mcp add --transport http owncontext https://owncontext.example/mcp');
  });
});

describe('setup orchestration with all external commands stubbed', () => {
  it('creates once, seeds only absent files, passes secrets via stdin and resumes without remote writes', async () => {
    const root = await fixture(); const fake = remote(); const deps = dependencies(fake.run);
    const result = await executeSetup(root, config, deps);
    expect(result.changed).toBe(true);
    expect(fake.calls.filter(call => call.args[0] === 'repo')).toHaveLength(1);
    expect(fake.files.size).toBe(1);
    const bulk = fake.calls.find(call => call.args[1] === 'bulk')!;
    expect(bulk.input).toContain('synthetic-private-value');
    expect(JSON.stringify(fake.calls.map(({ command, args }) => ({ command, args })))).not.toContain('synthetic-private-value');
    for (const file of await readdir(join(root, '.owncontext')))
      expect(await readFile(join(root, '.owncontext', file), 'utf8')).not.toContain('synthetic-private-value');
    const initialCalls = fake.calls.length;
    expect((await executeSetup(root, config, deps)).changed).toBe(false);
    expect(fake.calls.slice(initialCalls).some(call => call.args.includes('PUT') || ['deploy', 'repo'].includes(call.args[0]) || call.args.includes('bulk'))).toBe(false);
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.askSecret).toHaveBeenCalledTimes(2);
  });
  it('rechecks remote state after a failed deploy rather than duplicating resources', async () => {
    const root = await fixture(); const fake = remote(); const deps = dependencies(fake.run);
    fake.failDeploy();
    await expect(executeSetup(root, config, deps)).rejects.toThrow('External output was withheld');
    expect(await readFile(join(root, '.owncontext/setup.json'), 'utf8')).not.toContain('deployedFingerprint');
    fake.recover();
    await executeSetup(root, config, deps);
    expect(fake.calls.filter(call => call.args[0] === 'repo')).toHaveLength(1);
    expect(fake.calls.filter(call => call.args[0] === 'kv' && call.args[2] === 'create')).toHaveLength(1);
    expect(fake.calls.filter(call => call.args.includes('PUT'))).toHaveLength(1);
  });
  it('resumes a failure after secret installation without losing the deploy checkpoint', async () => {
    const root = await fixture(); const fake = remote(); let deploys = 0;
    const deps = dependencies(async (command, args, options) => {
      if (args[0] === 'deploy' && ++deploys === 2) return { code: 1, stdout: 'private output', stderr: '' };
      return fake.run(command, args, options);
    });
    await expect(executeSetup(root, config, deps)).rejects.toThrow('Deploy Worker failed');
    expect(fake.secrets.size).toBe(2);
    expect(await readFile(join(root, '.owncontext/setup.json'), 'utf8')).not.toContain('deployedFingerprint');
    await executeSetup(root, config, deps);
    expect(deploys).toBe(3);
    expect(deps.askSecret).toHaveBeenCalledTimes(2);
    expect(fake.calls.filter(call => call.args[1] === 'bulk')).toHaveLength(1);
  });
  it('retains non-secret configuration when prerequisite checks fail', async () => {
    const root = await fixture();
    await expect(executeSetup(root, config, dependencies(async () => ({ code: 127, stdout: '', stderr: '' })))).rejects.toThrow('Install node');
    const saved = JSON.parse(await readFile(join(root, '.owncontext/setup.json'), 'utf8'));
    expect(saved.config).toEqual(config);
    expect(saved.deployedFingerprint).toBeUndefined();
  });
  it('cancellation does not create repositories, namespaces, secrets or deploy', async () => {
    const root = await fixture(); const fake = remote(); const deps = { ...dependencies(fake.run), confirm: async () => false };
    await expect(executeSetup(root, config, deps)).rejects.toThrow('cancelled');
    expect(fake.calls.some(call => call.args[0] === 'repo' || call.args[0] === 'deploy' || call.args.includes('create') || call.args.includes('PUT'))).toBe(false);
  });
  it('dry-run works without configuration or prerequisites, writes nothing and calls no external tools', async () => {
    const root = await fixture(); const before = await readdir(root);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(root, ['--dry-run', '--resume']);
    expect(await readdir(root)).toEqual(before);
    expect(output.mock.calls.flat().join('\n')).toContain('no account commands, prompts, configuration writes');
  });
});
