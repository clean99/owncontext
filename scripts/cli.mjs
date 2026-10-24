import { build } from 'esbuild';
import { Buffer } from 'node:buffer';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import process from 'node:process';
import { error } from 'node:console';

export async function run(name) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 24 || (major === 24 && minor < 11)) throw new Error('Node 24.11 or newer is required. Activate Node 24 LTS and retry.');
    const result = await build({ entryPoints: [join(root, `src/cli/${name}.ts`)], write: false,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'resolve-cli-dependencies', setup(build) {
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => ({ path: import.meta.resolve(path), external: true }));
      } }],
    });
    const { main } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
    await main(root);
  } catch (cause) {
    error(cause instanceof Error ? cause.message : 'Command failed. Check configuration and retry.');
    process.exitCode = 1;
  }
}
