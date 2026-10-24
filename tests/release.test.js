import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRelease, formatFinding, scanText } from '../scripts/check-release.mjs';

const roots = [];
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
const token = () => ['ghp_', 'x'.repeat(36)].join('');
function fixture() {
  mkdirSync(join(process.cwd(), '.cache'), { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.cache/release-test-'));
  roots.push(root);
  git(root, 'init', '--quiet');
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('release text checks', () => {
  it('permits reserved email examples and public npm sources', () => {
    expect(scanText('writer@example.invalid\nowner@example.com\nregistry=https://registry.npmjs.org/\n'
      + '"resolved": "https://registry.npmjs.org/example/-/example-1.0.0.tgz"')).toEqual([]);
  });
  it('permits code references and only the exact synthetic credential sentinels', () => {
    expect(scanText('token: process.env.OWNCONTEXT_ACCESS_TOKEN,')).toEqual([]);
    expect(scanText("token: 'fixture-repository-token'")).toEqual([]);
    expect(scanText(`token: '${['fixture', 'repository', 'token', 'changed'].join('-')}'`))
      .toContainEqual({ line: 1, rule: 'credential-assignment' });
  });
  it('rejects non-placeholder email without printing its value', () => {
    const email = ['synthetic-person', 'mail-provider.net'].join('@');
    const findings = scanText(`header\n${email}`);
    expect(findings).toContainEqual({ line: 2, rule: 'personal-email' });
    expect(JSON.stringify(findings)).not.toContain(email);
    expect(formatFinding({ path: `${email}.txt`, source: 'filename', ...findings[0] })).not.toContain(email);
  });
  it.each([
    ['credential-token', () => token()],
    ['credential-token', () => ['github_pat_', 'x'.repeat(40)].join('')],
    ['jwt-token', () => ['eyJ' + 'x'.repeat(12), 'y'.repeat(12), 'z'.repeat(12)].join('.')],
    ['private-key', () => ['-----BEGIN ', 'PRIVATE KEY-----'].join('')],
    ['credential-assignment', () => `CLOUDFLARE_API_TOKEN=${'a'.repeat(40)}`],
    ['credential-assignment', () => `OWNCONTEXT_ACCESS_TOKEN=${['12345678', 'b'.repeat(20), 'c'.repeat(20)].join(':')}`],
    ['bearer-token', () => `Authorization: Bearer ${'a'.repeat(40)}`],
    ['home-directory', () => ['', 'Users', 'synthetic-user', 'notes'].join('/')],
    ['internal-host', () => ['https:', '', 'service.corp', 'resource'].join('/')],
    ['non-public-registry', () => `registry=${['https:', '', 'packages.example.invalid'].join('/')}`],
    ['dependency-source', () => JSON.stringify({ resolved: ['https:', '', 'packages.example.invalid', 'a.tgz'].join('/') })],
  ])('rejects %s markers', (rule, input) => {
    expect(scanText(input()).some(finding => finding.rule === rule)).toBe(true);
  });
  it('ships no hardcoded private identifier digests', () => {
    const source = readFileSync(new URL('../scripts/check-release.mjs', import.meta.url), 'utf8');
    expect(source).not.toMatch(/['"][a-f0-9]{64}['"]/);
  });
  it('checks caller-supplied synthetic identifier fingerprints', () => {
    const phrase = 'synthetic-private-project';
    const markers = new Set([createHash('sha256').update(phrase).digest('hex')]);
    expect(scanText(`repo: ${phrase.toUpperCase()}`, markers)).toContainEqual({ line: 1, rule: 'private-identifier' });
    expect(scanText('synthetic private project', markers)).toContainEqual({ line: 1, rule: 'private-identifier' });
    expect(scanText('unrelated project', markers)).toEqual([]);
  });
});

describe('release file coverage', () => {
  it('checks untracked and staged versions while excluding only ignored untracked files', () => {
    const root = fixture();
    writeFileSync(join(root, '.gitignore'), '.local-secret\n');
    writeFileSync(join(root, '.local-secret'), token());
    writeFileSync(join(root, 'note.txt'), token());
    expect(checkRelease(root).findings).toContainEqual({ path: 'note.txt', source: 'worktree', line: 1, rule: 'credential-token' });
    git(root, 'add', 'note.txt');
    writeFileSync(join(root, 'note.txt'), 'clean\n');
    expect(checkRelease(root).findings).toEqual([{ path: 'note.txt', source: 'index', line: 1, rule: 'credential-token' }]);
    git(root, 'add', 'note.txt');
    expect(checkRelease(root).findings).toEqual([]);
    git(root, 'add', '--force', '.local-secret');
    expect(checkRelease(root).findings.filter(finding => finding.path === '.local-secret')).toHaveLength(2);
  });
  it('rejects symlinks without reading the target', () => {
    const root = fixture();
    symlinkSync('nonexistent-target', join(root, 'link'));
    expect(checkRelease(root).findings).toEqual([{ path: 'link', source: 'worktree', line: 1, rule: 'unsupported-file-type' }]);
    git(root, 'add', 'link');
    expect(checkRelease(root).findings.some(finding => finding.source === 'index')).toBe(true);
  });
  it('loads private markers only from the release environment and redacts matching filenames', () => {
    const root = fixture();
    mkdirSync(join(root, 'scripts'));
    const script = join(root, 'scripts/check-release.mjs');
    copyFileSync(new URL('../scripts/check-release.mjs', import.meta.url), script);
    const marker = 'synthetic-sensitive-project';
    const env = { ...process.env, OWNCONTEXT_PRIVATE_MARKERS: JSON.stringify([marker]) };
    writeFileSync(join(root, `${marker}.txt`), 'synthetic sensitive project');
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('private-identifier');
    expect(result.stderr).toContain('[redacted filename]');
    expect(result.stdout + result.stderr).not.toContain(marker);
    const withoutMarkers = spawnSync(process.execPath, [script], { encoding: 'utf8',
      env: { ...env, OWNCONTEXT_PRIVATE_MARKERS: '[]' } });
    expect(withoutMarkers.status).toBe(0);
  });
  it.each(['not-json', '{"marker":"synthetic"}', '[""]', '[123]'])('fails closed for malformed private marker configuration: %s', value => {
    const root = fixture();
    mkdirSync(join(root, 'scripts'));
    const script = join(root, 'scripts/check-release.mjs');
    copyFileSync(new URL('../scripts/check-release.mjs', import.meta.url), script);
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8',
      env: { ...process.env, OWNCONTEXT_PRIVATE_MARKERS: value } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Release check could not scan');
    expect(result.stdout + result.stderr).not.toContain(value);
  });
  it('returns a failing CLI exit status without printing credential values', () => {
    const root = fixture();
    mkdirSync(join(root, 'scripts'));
    const script = join(root, 'scripts/check-release.mjs');
    copyFileSync(new URL('../scripts/check-release.mjs', import.meta.url), script);
    const clean = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('Release check passed');
    writeFileSync(join(root, 'bad.txt'), token());
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('credential-token');
    expect(result.stdout + result.stderr).not.toContain(token());
  });
});
