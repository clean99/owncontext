import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubRepository, KnowledgeError, MAX_FILE_BYTES, validatePath } from '../src/github';
import { frontmatter, note, parseTime, validDay } from '../src/knowledge';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/tools';
import { AUTH_SCOPES, OPTIONAL_TOOLS } from '../src/env';
import { fixtureEnv } from './support/env';
import { RepositoryFixture } from './support/repository';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('repository boundaries', () => {
  it.each(['/me/profile.md', '../me/profile.md', 'me/../profile.md', 'me\\profile.md', 'me/%2e%2e/x.md',
    'me//profile.md', 'me/\0profile.md', 'config/secret.txt', '.env', 'me/photo.png'])('rejects %s', path => {
    expect(() => validatePath(path)).toThrow(KnowledgeError);
  });
  it.each(['me/values.md', 'me/VALUES.md', 'AGENTS.md', 'topics/AGENTS.md', 'docs/guide.md'])('protects writes to %s', path => {
    expect(() => validatePath(path, 'write')).toThrow(KnowledgeError);
  });
  it.each(['HANDOVER.md', 'START_HERE.md', 'integrations/owncontext.json'])('reads the handover entry %s without allowing writes', async path => {
    const fixture = new RepositoryFixture();
    fixture.set(path, 'handover content');
    const service = fixture.service();
    expect(await service.read(path)).toMatchObject({ path, text: 'handover content' });
    await expect(service.remember({ path, fact: 'changed', source: 'stated' })).rejects.toMatchObject({ status: 403, code: 'protected_file' });
    await expect(service.updateNote({ path, name: 'changed', description: 'changed', body: 'changed', expected_sha: null }))
      .rejects.toMatchObject({ status: 403, code: 'protected_file' });
    await expect(service.repo.put(path, 'changed', undefined, 'change')).rejects.toMatchObject({ status: 403, code: 'protected_file' });
    expect(fixture.requests.some(request => request.init?.method === 'PUT')).toBe(false);
  });
  it.each(['integrations/other.json', 'integrations/private.md', 'integrations/owncontext.json/extra.md'])('keeps other integration paths private: %s', async path => {
    const fixture = new RepositoryFixture();
    fixture.set(path, 'private configuration');
    const service = fixture.service();
    expect((await service.repo.tree()).tree).toEqual([]);
    await expect(service.read(path)).rejects.toMatchObject({ status: 403, code: 'path_not_allowed' });
    await expect(service.repo.put(path, 'changed', undefined, 'change')).rejects.toMatchObject({ status: 403, code: 'path_not_allowed' });
    expect(fixture.requests.some(request => request.url.includes('/git/blobs/') || request.init?.method === 'PUT')).toBe(false);
  });
  it('accepts another configured repository but rejects a public target', async () => {
    expect(new GitHubRepository('token', 'other-user', 'other').base).toBe('https://api.github.com/repos/other-user/other');
    const fixture = new RepositoryFixture(); fixture.privateRepo = false;
    await expect(fixture.service().getContext()).rejects.toThrow('repository_must_be_private');
  });
  it('never fetches symlink or oversized blobs', async () => {
    const fixture = new RepositoryFixture();
    fixture.set('topics/link.md', 'me/values.md', '120000');
    fixture.set('topics/large.md', 'a'.repeat(MAX_FILE_BYTES + 1));
    expect((await fixture.service().repo.tree()).tree).toEqual([]);
    await expect(fixture.service().read('topics/link.md')).rejects.toThrow('file_not_found');
    expect(fixture.requests.some(request => request.url.includes('/git/blobs/'))).toBe(false);
  });
  it('rejects NUL content before any repository request', async () => {
    const fixture = new RepositoryFixture();
    await expect(fixture.service().repo.put('topics/new.md', 'Invalid\0content', undefined, 'create note'))
      .rejects.toMatchObject({ status: 415, code: 'binary_content' });
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.commits).toBe(0);
  });
  it('retries only three conflicts and never emits the upstream body', async () => {
    const fixture = new RepositoryFixture(); fixture.conflicts = 100;
    await expect(fixture.service().remember({ path: 'topics/x.md', fact: 'x', source: 'stated' })).rejects.toThrow('github_request_failed');
    expect(fixture.requests.filter(request => request.init?.method === 'PUT')).toHaveLength(4);
  });
});

describe('knowledge and event writes', () => {
  it('preserves date-only fact precision and deduplicates retries', async () => {
    const fixture = new RepositoryFixture();
    const input = { path: 'topics/fitness.md', fact: '测试晨练记录', source: 'stated' as const, occurred_at: '2026-10-12' };
    await fixture.service().remember(input);
    const text = fixture.files.get(input.path)!.text;
    expect(text).toContain('Occurred: 2026-10-12;');
    expect(text).not.toContain('T08:00');
    expect((await fixture.service().remember(input)).unchanged).toBe(true);
    expect(fixture.commits).toBe(1);
  });

  it('rejects impossible occurrence dates before any repository request', async () => {
    const fixture = new RepositoryFixture();
    await expect(fixture.service().remember({ path: 'topics/fitness.md', fact: '测试', source: 'stated', occurred_at: '2026-02-30' })).rejects.toThrow('invalid_time');
    expect(fixture.requests).toHaveLength(0);
  });

  it('normalizes common offset meal timestamps before deduplicating', async () => {
    const fixture = new RepositoryFixture();
    const input = { items: ['测试食物'], request_id: 'same-meal' };
    const first = await fixture.service().logMeal({ ...input, time: '2026-10-12 08:00 +08:00' });
    expect(first.time).toBe('2026-10-12T08:00:00.000+08:00');
    expect((await fixture.service().logMeal({ ...input, time: '2026-10-12T08:00:00+08:00' })).unchanged).toBe(true);
    expect(fixture.commits).toBe(1);
  });

  it('preserves concurrent changes while retrying an append', async () => {
    const fixture = new RepositoryFixture(); fixture.conflicts = 1;
    fixture.onConflict = () => fixture.set('topics/book.md', note({ name: '书', description: '阅读' }, '- [stated] 别处已写入。', '2026-10-11'));
    const result = await fixture.service().remember({ path: 'topics/book.md', fact: '新进度', source: 'stated', source_ref: 'raw/reference' });
    expect(result.commit).toBe('commit-1');
    expect(fixture.files.get('topics/book.md')!.text).toContain('别处已写入');
    expect(fixture.files.get('topics/book.md')!.text).toContain('新进度');
  });
  it('deduplicates the same fact without filtering its personal content', async () => {
    const fixture = new RepositoryFixture();
    const input = { path: 'me/health.md', fact: '本人陈述的健康、关系与工作资料', source: 'stated' as const };
    await fixture.service().remember(input);
    expect((await fixture.service().remember(input)).unchanged).toBe(true);
    expect(fixture.commits).toBe(1);
  });
  it('refuses stale full-note replacements and creates notes with metadata', async () => {
    const fixture = new RepositoryFixture();
    const original = await fixture.service().updateNote({ path: 'areas/project.md', name: '项目', description: '项目设计', body: '- [stated] 初始决定', expected_sha: null });
    fixture.set('areas/project.md', note({ name: '项目', description: '项目设计' }, '- [stated] 新决定', '2026-10-12'));
    await expect(fixture.service().updateNote({ path: 'areas/project.md', name: '项目', description: '项目设计', body: '- [stated] 旧版本', expected_sha: original.sha })).rejects.toThrow('note_changed_read_and_merge');
    expect(fixture.files.get('areas/project.md')!.text).toContain('新决定');
  });
  it('preserves omitted optional and custom nested metadata while revising a note', async () => {
    const fixture = new RepositoryFixture();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    fixture.set('topics/project.md', `---
name: 项目
description: 项目进展
aliases: [计划]
status: active
review_on: 2026-11-01
updated: 2026-10-12
sources:
  primary:
    path: raw/project.jsonl
    messages: [m1, m2]
---

- [stated] 初始进展
`);
    const original = fixture.files.get('topics/project.md')!;
    const result = await fixture.service().updateNote({ path: 'topics/project.md', name: '项目', description: '项目进展',
      body: '- [stated] 最新进展', expected_sha: original.sha });
    const saved = frontmatter(fixture.files.get('topics/project.md')!.text);
    expect(saved.metadata).toEqual({ ...frontmatter(original.text).metadata, updated: '2026-10-13' });
    expect(saved.body.trim()).toBe('- [stated] 最新进展');
    expect(result.commit).toBe('commit-1');
  });
  it('replaces optional metadata only when explicitly supplied', async () => {
    const fixture = new RepositoryFixture();
    fixture.set('topics/project.md', note({ name: '项目', description: '项目进展', aliases: ['计划'],
      status: 'active', review_on: '2026-11-01' }, '- [stated] 项目进展', '2026-10-12'));
    const original = fixture.files.get('topics/project.md')!;
    await fixture.service().updateNote({ path: 'topics/project.md', name: '项目新名称', description: '新说明', aliases: [],
      status: 'paused', review_on: '2026-12-01', body: '- [stated] 项目进展', expected_sha: original.sha });
    expect(frontmatter(fixture.files.get('topics/project.md')!.text).metadata).toMatchObject({ name: '项目新名称',
      description: '新说明', aliases: [], status: 'paused', review_on: '2026-12-01' });
    expect(fixture.commits).toBe(1);
  });
  it('keeps the original update date and bytes when content is unchanged across days', async () => {
    const fixture = new RepositoryFixture();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    const input = { path: 'topics/book.md', name: '阅读', description: '阅读记录', body: '- [stated] 正在读书' };
    const created = await fixture.service().updateNote({ ...input, aliases: ['书架'], status: 'active',
      review_on: '2026-11-01', expected_sha: null });
    const original = fixture.files.get(input.path)!.text;
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    const result = await fixture.service().updateNote({ ...input, body: `\n ${input.body}\n\n`, expected_sha: created.sha });
    expect(result).toEqual({ path: input.path, sha: created.sha, commit: null, unchanged: true });
    expect(fixture.files.get(input.path)!.text).toBe(original);
    expect(frontmatter(original).metadata.updated).toBe('2026-10-12');
    expect(fixture.commits).toBe(1);
  });
  it('returns unchanged when retrying a successful write with its original expected sha', async () => {
    const fixture = new RepositoryFixture();
    const input = { path: 'topics/project.md', name: '项目', description: '项目进展', body: '- [stated] 初始进展', expected_sha: null };
    const original = await fixture.service().updateNote(input);
    expect(await fixture.service().updateNote(input)).toEqual({ path: input.path, sha: original.sha, commit: null, unchanged: true });
    expect(fixture.commits).toBe(1);
  });
  it('rejects stale metadata changes even when the body matches the latest note', async () => {
    const fixture = new RepositoryFixture();
    const input = { path: 'topics/project.md', name: '项目', description: '项目进展', body: '- [stated] 项目进展' };
    const original = await fixture.service().updateNote({ ...input, status: 'active', expected_sha: null });
    fixture.set(input.path, note({ ...input, status: 'paused' }, input.body, '2026-10-12'));
    await expect(fixture.service().updateNote({ ...input, status: 'active',
      expected_sha: original.sha })).rejects.toThrow('note_changed_read_and_merge');
    expect(fixture.commits).toBe(1);
  });
  it('deduplicates meals and rejects a key with a different payload', async () => {
    const fixture = new RepositoryFixture();
    const meal = { time: '2026-10-31T23:59:00+08:00', items: ['午餐'], request_id: 'meal-1' };
    const result = await fixture.service().logMeal(meal);
    expect(result.path).toBe('data/meals/2026-10.jsonl');
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
    expect((await fixture.service().logMeal(meal)).unchanged).toBe(true);
    await expect(fixture.service().logMeal({ ...meal, items: ['别的内容'] })).rejects.toThrow('idempotency_key_reused');
    await expect(fixture.service().logMeal({ items: ['饭'], request_id: 'missing-time' })).rejects.toThrow('stable_request_id_requires_time');
    expect(fixture.commits).toBe(1);
  });
  it('uses Singapore date when a meal time has another offset', async () => {
    const fixture = new RepositoryFixture();
    const result = await fixture.service().logMeal({ time: '2026-09-30T20:00:00Z', items: ['晚饭'] });
    expect(result.path).toBe('data/meals/2026-10.jsonl');
    expect(result.time).toContain('2026-10-01T04:00:00');
  });
  it('keeps decision retries stable across days', async () => {
    const fixture = new RepositoryFixture();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    const input = { question: '读哪本书', data_used: ['本人兴趣'], ai_analysis: '推断性建议', my_decision: '决定读书', request_id: 'decision-1', recorded_on: '2026-10-12' };
    const result = await fixture.service().logDecision(input);
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    expect((await fixture.service().logDecision(input)).path).toBe(result.path);
    expect(fixture.commits).toBe(1);
    await expect(fixture.service().logDecision({ ...input, question: '改了问题' })).rejects.toThrow('decision_id_reused');
  });
  it('stores actual raw text, marks partial coverage, and reuses batch across months', async () => {
    const fixture = new RepositoryFixture();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    const input = { source: 'claude', conversation_id: 'conversation-1', batch_id: 'batch-1', captured_at: '2026-10-12T18:00:00+08:00',
      messages: [{ id: 'm1', role: 'user' as const, text: '完整原文\npassword=example-only' }] };
    const result = await fixture.service().capture(input);
    const rows = fixture.files.get(result.path)!.text.trim().split('\n').map(line => JSON.parse(line));
    expect(rows[0].coverage).toBe('partial');
    expect(rows[0].representation).toBe('source_text');
    expect(rows[1].text).toBe(input.messages[0].text);
    vi.setSystemTime(new Date('2026-11-12T10:00:00Z'));
    expect((await fixture.service().capture(input)).path).toBe(result.path);
    expect(fixture.commits).toBe(1);
    await expect(fixture.service().capture({ ...input, messages: [{ role: 'user', text: 'changed' }] })).rejects.toThrow('batch_id_reused');
  });
  it('rejects oversize capture before sending a write', async () => {
    const fixture = new RepositoryFixture();
    await expect(fixture.service().capture({ source: 'cli', conversation_id: 'c', batch_id: 'b', captured_at: '2026-10-12T18:00:00+08:00',
      messages: [{ role: 'user', text: '中'.repeat(70_000) }] })).rejects.toThrow('split_capture');
    expect(fixture.commits).toBe(0);
  });
});

describe('retrieval and time', () => {
    it('loads a bounded card without rules or topic bodies and exposes source versions', async () => {
    const fixture = new RepositoryFixture(); fixture.seedContext();
    fixture.set('topics/unrelated.md', note({ name: 'other', description: 'other' }, 'UNRELATED', '2026-10-12'));
    fixture.set('me/profile.md', note({ name: 'profile', description: 'profile' }, '- [stated] ' + '人😀'.repeat(500), '2026-10-12'));
    const result = await fixture.service().getContext();
    expect(result.mode).toBe('brief');
    expect(result.index).toEqual([]); expect(result.next_cursor).toBeNull();
    expect('card' in result && result.card?.[0]).toMatchObject({ path: 'me/profile.md', truncated: true });
    expect('card' in result && [...result.card![0].excerpt]).toHaveLength(180);
    const fetched = fixture.requests.filter(request => request.url.includes('/git/blobs/')).map(request => request.url.split('/').pop());
    expect(fetched).not.toContain(fixture.files.get('AGENTS.md')!.sha);
    expect(fetched).not.toContain(fixture.files.get('topics/unrelated.md')!.sha);
    expect(fetched).toHaveLength(3);
  });

it('returns rules, profiles, descriptions and a real continuation cursor', async () => {
    const fixture = new RepositoryFixture(); fixture.seedContext();
    for (let i = 0; i < 30; i++) fixture.set(`topics/topic-${i}.md`, note({ name: '主题', description: '主题说明' }, '- [stated] 内容', '2026-10-12'));
    const first = await fixture.service().getContext(undefined, 'full');
    expect(first.profiles['AGENTS.md']).toContain('Save only user-selected information');
    expect(first.index).toHaveLength(25);
    const second = await fixture.service().getContext(first.next_cursor!);
    expect(second.index).toHaveLength(8);
    expect(second.next_cursor).toBeNull();
  });
  it('searches case-insensitively and continues inside a file after 30 hits', async () => {
    const fixture = new RepositoryFixture();
    fixture.set('topics/search.md', Array.from({ length: 35 }, (_, index) => `APPLE ${index}`).join('\n'));
    const first = await fixture.service().search('apple', 'topics/');
    expect(first.matches).toHaveLength(30);
    expect(first.matches[0]).toMatchObject({ line: 1, before: null, match: 'APPLE 0', after: 'APPLE 1' });
    const second = await fixture.service().search('apple', 'topics/', first.next_cursor!);
    expect(second.matches).toHaveLength(5);
    expect(second.matches[0].line).toBe(31);
  });
  it('shows partial scan coverage and rejects stale cursors', async () => {
    const fixture = new RepositoryFixture();
    for (let i = 0; i < 30; i++) fixture.set(`topics/x-${i}.txt`, 'unrelated');
    const first = await fixture.service().search('needle');
    expect(first.matches).toEqual([]);
    expect(first.next_cursor).not.toBeNull();
    fixture.set('topics/new.txt', 'needle');
    await expect(fixture.service().search('needle', '', first.next_cursor!)).rejects.toThrow('index_changed');
  });
  it('marks a huge matching line as truncated', async () => {
    const fixture = new RepositoryFixture(); fixture.set('raw/conversations/2026-10/x.jsonl', 'needle' + 'x'.repeat(190_000));
    const result = await fixture.service().search('needle');
    expect(result.matches[0]).toMatchObject({ truncated: true });
  });
  it('accepts minute precision with an explicit offset while rejecting ambiguous times', () => {
    expect(parseTime('2026-10-12T08:00+08:00', 'Asia/Singapore')).toBe('2026-10-12T08:00:00.000+08:00');
    for (const value of ['2026-10-12', '2026-10-12 08:00', '2026-10-12T24:00:00+08:00', '2026-10-12 08:60 +08:00'])
      expect(() => parseTime(value)).toThrow();
  });
  it('validates calendar days and offsets without unhandled exceptions', () => {
    expect(validDay('2026-99-99')).toBe(false);
    expect(validDay('2026-02-30')).toBe(false);
    expect(validDay('2028-02-29')).toBe(true);
    expect(() => parseTime('2026-10-12T10:00:00')).toThrow('time_requires_offset');
    expect(() => parseTime('2026-02-30T10:00:00Z')).toThrow('invalid_time');
  });
});

describe('MCP tool contract', () => {
  it('lists and calls all eight tools through the protocol without logging contents', async () => {
    const fixture = new RepositoryFixture(); fixture.seedContext();
    vi.stubGlobal('fetch', fixture.fetch);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const server = createServer(fixtureEnv({ ENABLED_TOOLS: OPTIONAL_TOOLS.join(',') }), AUTH_SCOPES);
    const client = new Client({ name: 'contract-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name).sort()).toEqual([
      'capture_conversation', 'get_context', 'log_decision', 'log_meal', 'read', 'remember', 'search', 'update_note',
    ]);
    const calls = [
      ['get_context', {}],
      ['search', { query: '资料' }],
      ['read', { path: 'me/profile.md' }],
      ['remember', { path: 'topics/general.md', fact: 'private-fixture-value', source: 'stated' }],
      ['log_meal', { items: ['测试食物'], time: '2026-10-12T12:00:00+08:00', request_id: 'test-meal' }],
      ['log_decision', { question: '测试问题', data_used: [], ai_analysis: '测试分析', my_decision: '测试决定' }],
      ['update_note', { path: 'summaries/example.md', name: '摘要', description: '测试来源摘要', status: 'active', body: '- [inferred] 测试总结', expected_sha: null }],
      ['capture_conversation', { source: 'test', conversation_id: 'test-c', batch_id: 'test-b', captured_at: '2026-10-12T12:00:00+08:00', messages: [{ role: 'user', text: 'private-fixture-value' }] }],
    ] as const;
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).not.toBe(true);
    }
    expect(frontmatter(fixture.files.get('summaries/example.md')!.text).metadata.status).toBe('active');
    const forbidden = await client.callTool({ name: 'remember', arguments: { path: 'me/values.md', fact: 'private-fixture-value', source: 'stated' } });
    expect(forbidden.isError).toBe(true);
    expect(logs.mock.calls).toHaveLength(9);
    for (const [line] of logs.mock.calls) {
      expect(Object.keys(JSON.parse(line))).toEqual(['tool', 'status']);
      expect(line).not.toContain('private-fixture-value');
    }
    await client.close(); await server.close();
  });
});
