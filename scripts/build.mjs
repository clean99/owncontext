import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { error } from 'node:console';
import process from 'node:process';
import { checkBuildArtifacts, portableSourceMap } from './build-artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
const directory = join(root, '.cache/build');
const output = join(root, 'dist/worker');
const bundled = join(directory, 'worker');
rmSync(join(root, 'dist'), { recursive: true, force: true });
rmSync(bundled, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });
const configPath = join(directory, 'wrangler.json');
writeFileSync(configPath, JSON.stringify({ ...config, $schema: '../../node_modules/wrangler/config-schema.json',
  main: '../../src/index.ts', kv_namespaces: [{ binding: 'OAUTH_KV', id: '0'.repeat(32) }] }));
const result = spawnSync(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'),
  'deploy', '--dry-run', '--outdir', bundled, '--config', configPath], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_SANITIZE: 'true',
    WRANGLER_HIDE_BANNER: 'true', TMPDIR: directory, WRANGLER_LOG_PATH: join(root, '.cache/wrangler') },
});
if (result.error) error('Unable to start Wrangler. Install dependencies with npm ci and use Node 24.11 or newer.');
process.exitCode = result.status ?? 1;
try {
  if (process.exitCode === 0) {
    mkdirSync(output, { recursive: true });
    for (const entry of readdirSync(bundled, { withFileTypes: true })) {
      if (!entry.isFile()) throw new Error('Unexpected Wrangler build artifact type.');
      const contents = readFileSync(join(bundled, entry.name));
      writeFileSync(join(output, entry.name), entry.name.endsWith('.map')
        ? JSON.stringify(portableSourceMap(JSON.parse(contents.toString('utf8')), bundled, root, output))
        : contents);
    }
    checkBuildArtifacts(join(root, 'dist'), root);
  }
} catch {
  error('Build artifact privacy check failed. No distribution was retained.');
  process.exitCode = 1;
} finally {
  rmSync(bundled, { recursive: true, force: true });
  if (process.exitCode !== 0) rmSync(join(root, 'dist'), { recursive: true, force: true });
}
