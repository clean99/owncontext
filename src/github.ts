import { validateRepositoryConfiguration, type OptionalTool, type RepositoryOptions } from './env';
import { MODULE_WRITE_PATHS, NOTE_ROOTS, PROTECTED_PATHS, READ_ONLY_FILES, READ_ROOTS } from './layout';

export const MAX_FILE_BYTES = 200 * 1024;
const TEXT_EXTENSION = /\.(md|txt|json|jsonl|csv|yaml|yml)$/i;

export class KnowledgeError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export function validatePath(path: string, mode: 'read' | 'note' | 'write' = 'read', enabledTools: readonly OptionalTool[] = []): string {
  if (!path || path.length > 240 || path.includes('..') || /[\\%]/.test(path)
    || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || path.startsWith('/') || path.split('/').some(part => !part || part.startsWith('.'))) {
    throw new KnowledgeError(400, 'invalid_path');
  }
  const root = path.split('/')[0];
  if (!READ_ONLY_FILES.has(path) && (!READ_ROOTS.has(root) || !path.includes('/')))
    throw new KnowledgeError(403, 'path_not_allowed');
  if (!TEXT_EXTENSION.test(path)) throw new KnowledgeError(415, 'text_files_only');
  if (mode !== 'read' && (READ_ONLY_FILES.has(path) || PROTECTED_PATHS.has(path.toLowerCase())
    || /(?:^|\/)(?:agents|claude)\.md$/i.test(path))) {
    throw new KnowledgeError(403, 'protected_file');
  }
  if (mode === 'note' && (!NOTE_ROOTS.has(root) || !path.endsWith('.md')))
    throw new KnowledgeError(403, 'note_path_not_allowed');
  if (mode === 'write' && !NOTE_ROOTS.has(root)
    && !enabledTools.some(tool => MODULE_WRITE_PATHS[tool].test(path))) {
    throw new KnowledgeError(403, 'write_path_not_allowed');
  }
  return path;
}

export function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function encode(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface FileEntry { path: string; sha: string; size: number; mode: string; type: string }
export interface FileData { path: string; sha: string; text: string }
export interface Tree { sha: string; tree: FileEntry[]; truncated: boolean }
export interface WriteResult { path: string; sha: string; commit: string | null; unchanged: boolean }
type Fetch = typeof fetch;

export class GitHubRepository {
  private branch?: string;
  private snapshot?: Tree;
  private content = new Map<string, string>();
  readonly base: string;

  readonly enabledTools: readonly OptionalTool[];
  private committer?: RepositoryOptions['committer'];

  constructor(private token: string, owner: string, repo: string, private request: Fetch = (input, init) => fetch(input, init), options: RepositoryOptions = {}) {
    validateRepositoryConfiguration(token, owner, repo, options);
    this.enabledTools = Object.freeze([...(options.enabledTools ?? [])]);
    this.committer = options.committer ? { ...options.committer } : undefined;
    this.base = `https://api.github.com/repos/${owner}/${repo}`;
  }

  private async api<T>(suffix: string, init: RequestInit = {}): Promise<T> {
    if (!this.token) throw new KnowledgeError(503, 'repository_token_missing');
    let response: Response;
    try {
      response = await this.request(this.base + suffix, {
        ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: {
          'Authorization': `Bearer ${this.token}`, 'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'owncontext',
          'Content-Type': 'application/json',
        },
      });
    } catch { throw new KnowledgeError(502, 'github_unavailable'); }
    if (!response.ok) throw new KnowledgeError(response.status, 'github_request_failed');
    return response.json() as Promise<T>;
  }

  private async privateBranch(): Promise<string> {
    if (this.branch) return this.branch;
    const repo = await this.api<{ private: boolean; default_branch: string }>('');
    if (!repo.private) throw new KnowledgeError(403, 'repository_must_be_private');
    this.branch = repo.default_branch;
    return this.branch;
  }

  async tree(refresh = false): Promise<Tree> {
    if (!refresh && this.snapshot) return this.snapshot;
    const branch = await this.privateBranch();
    const tree = await this.api<Tree>(`/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (tree.truncated) throw new KnowledgeError(413, 'repository_tree_truncated');
    this.snapshot = {
      ...tree, tree: tree.tree.filter(entry => {
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)
          || entry.size > MAX_FILE_BYTES) return false;
        try { validatePath(entry.path); return true; } catch { return false; }
      }).sort((a, b) => a.path.localeCompare(b.path)),
    };
    return this.snapshot;
  }

  async read(path: string, refresh = false): Promise<FileData | null> {
    validatePath(path);
    const tree = await this.tree(refresh);
    const entry = tree.tree.find(file => file.path === path);
    if (!entry) return null;
    let text = this.content.get(entry.sha);
    if (text === undefined) {
      const blob = await this.api<{ size: number; encoding: string; content: string }>(`/git/blobs/${entry.sha}`);
      if (blob.size > MAX_FILE_BYTES || blob.encoding !== 'base64')
        throw new KnowledgeError(413, 'file_too_large_or_not_text');
      try {
        const raw = atob(blob.content.replace(/\s/g, ''));
        if (raw.length > MAX_FILE_BYTES) throw new Error('size');
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(raw, char => char.charCodeAt(0)));
      } catch { throw new KnowledgeError(415, 'invalid_utf8'); }
      if (text.includes('\0')) throw new KnowledgeError(415, 'binary_content');
      if (this.content.size >= 40) this.content.delete(this.content.keys().next().value!);
      this.content.set(entry.sha, text);
    }
    return { path, sha: entry.sha, text };
  }

  async put(path: string, text: string, sha: string | undefined, message: string): Promise<WriteResult> {
    validatePath(path, 'write', this.enabledTools);
    if (bytes(text) > MAX_FILE_BYTES) throw new KnowledgeError(413, 'file_too_large');
    if (text.includes('\0')) throw new KnowledgeError(415, 'binary_content');
    const branch = await this.privateBranch();
    const result = await this.api<{ content: { sha: string }; commit: { sha: string } }>(
      `/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'PUT', body: JSON.stringify({ message, content: encode(text), sha, branch,
        committer: this.committer }) },
    );
    this.snapshot = undefined;
    return { path, sha: result.content.sha, commit: result.commit.sha, unchanged: false };
  }

  async mutate(path: string, message: string, transform: (current: string | null) => string): Promise<WriteResult> {
    validatePath(path, 'write', this.enabledTools);
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.read(path, true);
      const next = transform(current?.text ?? null);
      if (current?.text === next) return { path, sha: current.sha, commit: null, unchanged: true };
      try { return await this.put(path, next, current?.sha, message); }
      catch (error) {
        if (!(error instanceof KnowledgeError) || ![409, 422].includes(error.status) || attempt === 3) throw error;
      }
    }
    throw new KnowledgeError(409, 'write_conflict');
  }
}
