import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitHubRepository, KnowledgeError } from '../github';
import { KnowledgeService } from '../knowledge';
import { roundTrip, ToolFailure, type ToolClient } from './round-trip';

export async function readTemplate(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(directory: string, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${path}/`);
      else if (entry.isFile()) files[path] = await readFile(join(directory, entry.name), 'utf8');
    }
  }
  await walk(root);
  return files;
}

export class MemoryGitHub {
  private files = new Map<string, { text: string; sha: string }>();
  writes = 0;
  constructor(seed: Record<string, string>) { for (const [path, text] of Object.entries(seed)) this.set(path, text); }
  private set(path: string, text: string) {
    const sha = createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
    this.files.set(path, { text, sha });
  }
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const base = '/repos/sample-user/sample-notes';
    if (url.origin !== 'https://api.github.com' || !url.pathname.startsWith(base)) throw new Error('Demo network access denied.');
    const path = url.pathname.slice(base.length);
    if (path === '') return Response.json({ private: true, default_branch: 'main' });
    if (path === '/git/trees/main') return Response.json({ sha: String(this.writes), truncated: false,
      tree: [...this.files].map(([path, file]) => ({ path, sha: file.sha, size: Buffer.byteLength(file.text), type: 'blob', mode: '100644' })) });
    if (path.startsWith('/git/blobs/')) {
      const file = [...this.files.values()].find(file => file.sha === path.slice('/git/blobs/'.length));
      if (file) return Response.json({ size: Buffer.byteLength(file.text), encoding: 'base64', content: Buffer.from(file.text).toString('base64') });
    }
    if (path.startsWith('/contents/') && init?.method === 'PUT') {
      const target = path.slice('/contents/'.length).split('/').map(decodeURIComponent).join('/');
      const body = JSON.parse(String(init.body));
      if (body.sha !== this.files.get(target)?.sha) return new Response(null, { status: 409 });
      this.set(target, Buffer.from(body.content, 'base64').toString('utf8'));
      this.writes++;
      return Response.json({ content: { sha: this.files.get(target)!.sha }, commit: { sha: String(this.writes) } });
    }
    return new Response(null, { status: 404 });
  };
  client(): ToolClient {
    return { call: async (name, args) => {
      const service = new KnowledgeService(new GitHubRepository('synthetic-demo', 'sample-user', 'sample-notes', this.fetch));
      try {
        if (name === 'remember') return { ...await service.remember(args as Parameters<KnowledgeService['remember']>[0]) };
        if (name === 'read') return { ...await service.read(String(args.path)) };
        if (name === 'update_note') return { ...await service.updateNote({ path: String(args.path), name: String(args.name),
          description: String(args.description), body: String(args.body), expected_sha: typeof args.expected_sha === 'string' ? args.expected_sha : null }) };
        throw new Error('Unsupported demo tool.');
      } catch (error) {
        if (error instanceof KnowledgeError) throw new ToolFailure(error.status, error.code);
        throw error;
      }
    } };
  }
}

export async function runDemo(template: Record<string, string>) {
  const repository = new MemoryGitHub(template);
  const result = await roundTrip(repository.client(), repository.client(), 'me/preferences.md');
  return { ...result, writes: repository.writes };
}

export async function main(root: string) {
  const result = await runDemo(await readTemplate(join(root, 'templates/knowledge')));
  console.log('OwnContext local demo — synthetic data, in memory, no accounts or network.');
  console.log('Client 1 saved a stated preference with a source link; repeating it made no extra write.');
  console.log(`Client 2 read the same Markdown (SHA ${result.savedSha}) and corrected the preference.`);
  console.log(result.diff);
  console.log(`Stale-SHA write rejected (409). Correction preserved at SHA ${result.correctedSha}.`);
}
