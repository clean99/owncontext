import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export interface CommandResult { code: number; stdout: string; stderr: string }
export type CommandRunner = (command: string, args: string[], options?: { input?: string; env?: Record<string, string> }) => Promise<CommandResult>;

export function commandRunner(root: string): CommandRunner {
  return (command, args, options = {}) => new Promise(resolve => {
    const child = spawn(command, args, { cwd: root, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GH_HOST: 'github.com', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_SANITIZE: 'true',
        WRANGLER_LOG_PATH: join(root, '.cache/wrangler'), CI: 'true', ...options.env } });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 4_000_000) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 4_000_000) child.kill('SIGKILL'); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: 127, stdout: '', stderr: '' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Local configuration is invalid; repair the JSON before resuming.'); }
}

export async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function prompt() {
  if (!process.stdin.isTTY) throw new Error('Interactive setup needs a terminal. Use --dry-run for an offline preview.');
  let hidden = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!hidden) process.stdout.write(chunk); callback(); } });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  return {
    async ask(label: string, fallback = '', secret = false) {
      if (secret) { process.stdout.write(`${label}: `); hidden = true; }
      try { return (await reader.question(secret ? '' : `${label}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback; }
      finally { if (secret) { hidden = false; process.stdout.write('\n'); } }
    },
    close() { reader.close(); },
  };
}
