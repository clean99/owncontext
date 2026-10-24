import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryGitHub, readTemplate, runDemo } from '../src/cli/demo';
import { markdownDiff, roundTrip, ToolFailure } from '../src/cli/round-trip';

afterEach(() => vi.unstubAllGlobals());

describe('offline demo', () => {
  it('uses the synthetic template, two clients, provenance, correction and real SHA conflicts without fetch', async () => {
    const network = vi.fn(() => { throw new Error('Network forbidden'); });
    vi.stubGlobal('fetch', network);
    const result = await runDemo(await readTemplate(join(process.cwd(), 'templates/knowledge')));
    expect(network).not.toHaveBeenCalled();
    expect(result.writes).toBe(2);
    expect(result.savedSha).toMatch(/^[a-f0-9]{40}$/);
    expect(result.correctedSha).not.toBe(result.savedSha);
    expect(result.markdown).toContain('Use short checklists for this garden project.');
    expect(result.markdown).toContain('[stated] For status updates, I prefer concise paragraphs.');
    expect(result.markdown).toContain('../raw/snippets/preferences.md#m2');
    expect(result.markdown).toContain('Superseded: [stated] For status updates, I prefer bullet lists.');
    expect(result.diff).toContain('-- [stated] For status updates, I prefer bullet lists.');
    expect(result.diff).toContain('+- [stated] For status updates, I prefer concise paragraphs.');
    expect(result.conflictRejected).toBe(true);
  });

  it('does not mistake an authorization error for the expected stale-SHA conflict', async () => {
    const repository = new MemoryGitHub({});
    const first = repository.client();
    const call = first.call.bind(first);
    first.call = (name, args) => name === 'update_note' ? Promise.reject(new ToolFailure(403, 'insufficient_scope')) : call(name, args);
    await expect(roundTrip(first, repository.client(), 'topics/demo.md')).rejects.toMatchObject({ status: 403 });
  });

  it('fails when a broken client accepts the stale write', async () => {
    const repository = new MemoryGitHub({});
    const first = repository.client();
    const call = first.call.bind(first);
    first.call = (name, args) => name === 'update_note' ? Promise.resolve({ sha: 'accepted' }) : call(name, args);
    await expect(roundTrip(first, repository.client(), 'topics/demo.md')).rejects.toThrow('A stale SHA was accepted');
  });

  it('renders a bounded unified hunk and no diff for unchanged text', () => {
    expect(markdownDiff('a.md', 'one\ntwo\nthree\n', 'one\nnew\nthree\n')).toBe('--- a/a.md\n+++ b/a.md\n@@ -1,3 +1,3 @@\n one\n-two\n+new\n three');
    expect(markdownDiff('a.md', 'same', 'same')).toBe('');
  });
});
