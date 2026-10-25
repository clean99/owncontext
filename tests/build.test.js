import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBuildArtifacts, portableSourceMap } from '../scripts/build-artifacts.mjs';

const roots = [];
function fixture(exitCode = 0, artifact = 'export default {};') {
  mkdirSync(join(process.cwd(), '.cache'), { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.cache/build-test-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'node_modules/wrangler/bin'), { recursive: true });
  for (const file of ['build.mjs', 'build-artifacts.mjs'])
    copyFileSync(new URL(`../scripts/${file}`, import.meta.url), join(root, 'scripts', file));
  writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ name: 'synthetic-worker', main: 'src/index.ts',
    compatibility_date: '2026-10-12', compatibility_flags: ['nodejs_compat'],
    kv_namespaces: [{ binding: 'OAUTH_KV', id: '' }] }));
  writeFileSync(join(root, 'node_modules/wrangler/bin/wrangler.js'), `
    const fs = require('node:fs');
    const path = require('node:path');
    fs.writeFileSync('received.json', JSON.stringify({ args: process.argv.slice(2), metrics: process.env.WRANGLER_SEND_METRICS,
      hideBanner: process.env.WRANGLER_HIDE_BANNER, temporary: process.env.TMPDIR }));
    const output = process.argv[process.argv.indexOf('--outdir') + 1];
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'index.js'), ${JSON.stringify(artifact)});
    fs.writeFileSync(path.join(output, 'index.js.map'), JSON.stringify({ version: 3, sourceRoot: output,
      sources: ['../../../src/index.ts'], sourcesContent: ['export default {};'], names: [], mappings: '' }));
    process.exitCode = ${exitCode};
  `);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('offline Worker build wrapper', () => {
  it('always dry-runs with a synthetic KV binding and preserves the source template', () => {
    const root = fixture();
    const original = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist/stale.js'), 'stale output');
    const result = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const received = JSON.parse(readFileSync(join(root, 'received.json'), 'utf8'));
    expect(received.args).toEqual(['deploy', '--dry-run', '--outdir', join(root, '.cache/build/worker'), '--config', join(root, '.cache/build/wrangler.json')]);
    expect(received.metrics).toBe('false');
    expect(received.hideBanner).toBe('true');
    expect(received.temporary).toBe(join(root, '.cache/build'));
    expect(JSON.parse(readFileSync(join(root, '.cache/build/wrangler.json'), 'utf8'))).toMatchObject({
      main: '../../src/index.ts', compatibility_flags: ['nodejs_compat'], kv_namespaces: [{ binding: 'OAUTH_KV', id: '0'.repeat(32) }],
    });
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toBe(original);
    expect(JSON.parse(readFileSync(join(root, 'dist/worker/index.js.map'), 'utf8'))).toEqual({
      version: 3, sourceRoot: '', sources: ['../../src/index.ts'], names: [], mappings: '',
    });
    expect(existsSync(join(root, '.cache/build/worker'))).toBe(false);
    expect(existsSync(join(root, 'dist/stale.js'))).toBe(false);
    expect(checkBuildArtifacts(join(root, 'dist'), root)).toBe(2);
  });
  it('propagates a failed Wrangler build', () => {
    const root = fixture(7);
    expect(spawnSync(process.execPath, [join(root, 'scripts/build.mjs')]).status).toBe(7);
    expect(existsSync(join(root, 'dist'))).toBe(false);
    expect(existsSync(join(root, '.cache/build/worker'))).toBe(false);
  });
  it.each(['/tmp/synthetic/project.ts', 'C:\\build\\project.ts', 'file:///workspace/project.ts'])('rejects leaked paths in any artifact', path => {
    const root = fixture();
    const output = join(root, 'dist');
    mkdirSync(output);
    writeFileSync(join(output, 'asset.txt'), JSON.stringify({ path }));
    expect(() => checkBuildArtifacts(output, root)).toThrow(/absolute filesystem path/);
  });
  it.each([
    { sources: ['/arbitrary/source.ts'] },
    { sources: ['../source.ts'], sourceRoot: '/arbitrary' },
    { sources: ['../source.ts'], sourcesContent: ['embedded text'] },
  ])('rejects nonportable source maps', map => {
    const root = fixture();
    const output = join(root, 'dist');
    mkdirSync(output);
    writeFileSync(join(output, 'index.js.map'), JSON.stringify(map));
    expect(() => checkBuildArtifacts(output, root)).toThrow();
  });
  it('fails the build and removes distributions containing filesystem paths', () => {
    const root = fixture(0, 'export default "/tmp/synthetic/private.ts";');
    const result = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Build artifact privacy check failed');
    expect(existsSync(join(root, 'dist'))).toBe(false);
    expect(existsSync(join(root, '.cache/build/worker'))).toBe(false);
  });
  it('rejects source references outside the checkout', () => {
    const root = fixture();
    expect(() => portableSourceMap({ sources: ['../../escape.ts'] }, root, root)).toThrow(/outside/);
  });
});
