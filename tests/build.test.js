import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

const roots = [];
function fixture(exitCode = 0) {
  mkdirSync(join(process.cwd(), '.cache'), { recursive: true });
  const root = mkdtempSync(join(process.cwd(), '.cache/build-test-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'node_modules/wrangler/bin'), { recursive: true });
  copyFileSync(new URL('../scripts/build.mjs', import.meta.url), join(root, 'scripts/build.mjs'));
  writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ name: 'synthetic-worker', main: 'src/index.ts',
    compatibility_date: '2026-10-12', compatibility_flags: ['nodejs_compat'],
    kv_namespaces: [{ binding: 'OAUTH_KV', id: '' }] }));
  writeFileSync(join(root, 'node_modules/wrangler/bin/wrangler.js'), `
    const fs = require('node:fs');
    fs.writeFileSync('received.json', JSON.stringify({ args: process.argv.slice(2), metrics: process.env.WRANGLER_SEND_METRICS,
      hideBanner: process.env.WRANGLER_HIDE_BANNER, temporary: process.env.TMPDIR }));
    process.exitCode = ${exitCode};
  `);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('offline Worker build wrapper', () => {
  it('always dry-runs with a synthetic KV binding and preserves the source template', () => {
    const root = fixture();
    const original = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
    const result = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const received = JSON.parse(readFileSync(join(root, 'received.json'), 'utf8'));
    expect(received.args).toEqual(['deploy', '--dry-run', '--outdir', join(root, 'dist/worker'), '--config', join(root, '.cache/build/wrangler.json')]);
    expect(received.metrics).toBe('false');
    expect(received.hideBanner).toBe('true');
    expect(received.temporary).toBe(join(root, '.cache/build'));
    expect(JSON.parse(readFileSync(join(root, '.cache/build/wrangler.json'), 'utf8'))).toMatchObject({
      main: '../../src/index.ts', compatibility_flags: ['nodejs_compat'], kv_namespaces: [{ binding: 'OAUTH_KV', id: '0'.repeat(32) }],
    });
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toBe(original);
  });
  it('propagates a failed Wrangler build', () => {
    const root = fixture(7);
    expect(spawnSync(process.execPath, [join(root, 'scripts/build.mjs')]).status).toBe(7);
  });
});
