import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { error, log } from 'node:console';
import process from 'node:process';

const absoluteSource = value => isAbsolute(value) || win32.isAbsolute(value) || /^[a-z][a-z0-9+.-]*:/i.test(value);
const localPath = /(?:^|[\s"'`=(])(?:\/(?:Users|home|root|private|tmp|var|opt|usr|workspace|workspaces|builds|runner|mnt|Volumes)\/|[a-z]:[\\/]|\\\\[a-z0-9_.-]+\\[a-z0-9_$.-]+)|file:\/\/[^"'`\s)]/im;

export function portableSourceMap(map, directory, root, destination = directory) {
  const base = resolve(directory, map.sourceRoot || '.');
  const sources = map.sources.map(source => {
    const path = resolve(base, source);
    const local = relative(root, path);
    if (local.startsWith('../') || isAbsolute(local) || win32.isAbsolute(source))
      throw new Error('Source map points outside the source checkout.');
    return relative(destination, path).split('\\').join('/');
  });
  const portable = { ...map, sourceRoot: '', sources };
  delete portable.sourcesContent;
  return portable;
}

export function checkBuildArtifacts(directory, root) {
  let files = 0;
  const markers = [resolve(root), homedir()].filter(path => path.length > 1);
  function inspect(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) { inspect(target); continue; }
      if (!entry.isFile()) throw new Error('Unsupported build artifact type.');
      files++;
      const text = readFileSync(target, 'utf8');
      const decoded = text.replaceAll('\\\\', '\\').replaceAll('\\/', '/');
      if (localPath.test(decoded) || markers.some(marker => decoded.includes(marker)))
        throw new Error('Build artifact contains an absolute filesystem path.');
      if (/sourceMappingURL=data:/.test(text)) throw new Error('Inline source maps are not allowed in build artifacts.');
      if (entry.name.endsWith('.map')) {
        const map = JSON.parse(text);
        if (!Array.isArray(map.sources) || map.sources.some(source => typeof source !== 'string' || absoluteSource(source))
          || (map.sourceRoot && absoluteSource(map.sourceRoot)) || (map.file && absoluteSource(map.file))
          || 'sourcesContent' in map || 'sections' in map)
          throw new Error('Source maps must use relative paths without embedded source text.');
      }
    }
  }
  inspect(directory);
  if (!files) throw new Error('Build artifacts are missing.');
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const files = checkBuildArtifacts(join(root, 'dist'), root);
    log(`Build artifact check passed: ${files} files; relative source paths only.`);
  } catch (cause) {
    error(cause instanceof Error ? cause.message : 'Build artifact check failed.');
    process.exitCode = 1;
  }
}
