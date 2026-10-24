import { GitHubRepository } from '../../src/github';
import { KnowledgeService, note } from '../../src/knowledge';
import { OPTIONAL_TOOLS, type OptionalTool } from '../../src/env';

export class RepositoryFixture {
  constructor(readonly owner = 'sample-user', readonly repo = 'sample-notes') {}
  files = new Map<string, { text: string; sha: string; mode: string }>();
  commits = 0;
  version = 1;
  privateRepo = true;
  conflicts = 0;
  onConflict?: () => void;
  requests: { url: string; init?: RequestInit }[] = [];

  set(path: string, text: string, mode = '100644') {
    this.files.set(path, { text, sha: (++this.version).toString(16).padStart(40, '0'), mode });
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    this.requests.push({ url, init });
    const suffix = url.replace(`https://api.github.com/repos/${this.owner}/${this.repo}`, '');
    if (!suffix) return Response.json({ private: this.privateRepo, default_branch: 'main' });
    if (suffix.startsWith('/git/trees/')) return Response.json({ sha: String(this.version), truncated: false,
      tree: [...this.files].map(([path, file]) => ({ path, sha: file.sha, type: 'blob', mode: file.mode,
        size: new TextEncoder().encode(file.text).length })) });
    if (suffix.startsWith('/git/blobs/')) {
      const file = [...this.files.values()].find(file => suffix.endsWith(file.sha));
      if (!file) return new Response('', { status: 404 });
      return Response.json({ size: new TextEncoder().encode(file.text).length, encoding: 'base64', content: Buffer.from(file.text).toString('base64') });
    }
    if (init?.method === 'PUT') {
      if (this.conflicts > 0) {
        this.conflicts--; this.onConflict?.();
        return new Response('', { status: 409 });
      }
      const path = suffix.replace('/contents/', '').split('/').map(decodeURIComponent).join('/');
      const body = JSON.parse(String(init.body));
      if ((this.files.get(path)?.sha ?? undefined) !== body.sha) return new Response('', { status: 409 });
      this.set(path, Buffer.from(body.content, 'base64').toString('utf8'));
      this.commits++;
      return Response.json({ content: { sha: this.files.get(path)!.sha }, commit: { sha: `commit-${this.commits}` } });
    }
    throw new Error(`Unexpected test endpoint: ${suffix}`);
  };

  service(enabledTools: readonly OptionalTool[] = OPTIONAL_TOOLS, timeZone = 'Asia/Singapore') {
    return new KnowledgeService(new GitHubRepository('fixture-token', this.owner, this.repo, this.fetch, { enabledTools }), { timeZone });
  }
  seedContext() {
    this.set('AGENTS.md', '# 规则\nSave only user-selected information。');
    for (const name of ['profile', 'preferences', 'values'])
      this.set(`me/${name}.md`, note({ name, description: `${name}说明` }, '- [stated] 已提供的资料。', '2026-10-12'));
  }
}
