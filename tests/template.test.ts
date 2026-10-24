import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { frontmatter } from '../src/notes';
import { CONTEXT_CARDS, RULES_PATH } from '../src/layout';
import { validDay } from '../src/time';
import { RepositoryFixture } from './support/repository';

const root = fileURLToPath(new URL('../templates/knowledge/', import.meta.url).href);
function templateFiles(directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? templateFiles(path) : [path];
  });
}
function templateFixture() {
  const fixture = new RepositoryFixture();
  for (const path of templateFiles()) fixture.set(relative(root, path), readFileSync(path, 'utf8'));
  return fixture;
}

describe('synthetic knowledge template', () => {
  it('provides typed note metadata and resolves every source link and anchor', () => {
    const files = templateFiles();
    expect(files.length).toBeGreaterThanOrEqual(6);
    let links = 0;
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      if (relative(root, path) !== RULES_PATH) {
        const { metadata } = frontmatter(text);
        expect(typeof metadata.name).toBe('string');
        expect(typeof metadata.description).toBe('string');
        expect(String(metadata.description).length).toBeGreaterThan(0);
        expect(Array.isArray(metadata.aliases)).toBe(true);
        expect((metadata.aliases as unknown[]).every(alias => typeof alias === 'string')).toBe(true);
        expect(validDay(String(metadata.updated))).toBe(true);
        if (metadata.review_on) expect(validDay(String(metadata.review_on))).toBe(true);
      }
      for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        links++;
        const [target, anchor] = match[1].split('#');
        const absolute = resolve(dirname(path), target);
        expect(files).toContain(absolute);
        if (anchor) expect(readFileSync(absolute, 'utf8')).toContain(`## ${anchor}\n`);
      }
    }
    expect(links).toBeGreaterThanOrEqual(6);
  });

  it('boots brief and full context without any private repository data', async () => {
    const fixture = templateFixture();
    const service = fixture.service([], 'UTC');
    const brief = await service.getContext();
    expect(brief.timezone).toBe('UTC');
    expect('card' in brief && brief.card?.map(card => card.path)).toEqual(CONTEXT_CARDS.map(([path]) => path));
    expect(brief.rules).toMatchObject({ path: RULES_PATH });
    expect(brief.guidance).toContain('Save only information the user selected');
    const full = await service.getContext(undefined, 'full');
    expect(full.profiles[RULES_PATH]).toContain('synthetic examples only');
    expect(full.index.some(note => note.path === 'topics/example.md')).toBe(true);
    const matches = await service.search('planting deadline');
    expect(matches.matches.some(hit => hit.path === 'raw/snippets/garden.md')).toBe(true);
    const topic = await service.read('topics/example.md');
    expect(topic.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(topic.text).toContain('[stated]');
    expect(topic.text).toContain('[inferred]');
    expect(topic.text).toContain('garden.md#m3');
  });

  it('protects template rules and values while supporting SHA-based topic correction', async () => {
    const fixture = templateFixture();
    const service = fixture.service([], 'UTC');
    for (const path of [RULES_PATH, 'me/values.md']) {
      const current = await service.read(path);
      await expect(service.updateNote({ path, name: 'Synthetic', description: 'Synthetic', body: 'Replacement', expected_sha: current.sha }))
        .rejects.toMatchObject({ code: 'protected_file' });
    }
    const current = await service.read('topics/example.md');
    const parsed = frontmatter(current.text);
    const input = { path: current.path, name: String(parsed.metadata.name), description: String(parsed.metadata.description),
      body: parsed.body + '\n- [inferred] A synthetic follow-up needs review. Source: synthetic-follow-up.\n', expected_sha: current.sha };
    await service.updateNote(input);
    expect((await service.updateNote(input)).unchanged).toBe(true);
    await expect(service.updateNote({ ...input, body: 'Stale replacement' })).rejects.toMatchObject({ code: 'note_changed_read_and_merge' });
    expect((await service.read(current.path)).text).toContain('garden.md#m3');
    expect(fixture.commits).toBe(1);
  });
});
