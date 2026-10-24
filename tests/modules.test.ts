import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { READ_SCOPE, WRITE_SCOPE, OPTIONAL_TOOLS, type OptionalTool } from '../src/env';
import { createServer } from '../src/tools';
import { fixtureEnv } from './support/env';
import { RepositoryFixture } from './support/repository';

const core = ['get_context', 'read', 'remember', 'search', 'update_note'];

afterEach(() => { vi.unstubAllGlobals(); });

describe('optional modules', () => {
  it.each([undefined, [WRITE_SCOPE]])('fails closed at the tool boundary without read permission: %j', async scopes => {
    const fetcher = vi.fn(() => { throw new Error('Knowledge must not be accessed'); });
    vi.stubGlobal('fetch', fetcher);
    const server = createServer(fixtureEnv(), scopes);
    const client = new Client({ name: 'scope-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      for (const [name, args] of [['read', { path: 'me/profile.md' }],
        ['remember', { path: 'topics/garden.md', fact: 'Synthetic preference', source: 'stated' }]] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(`"required_scope":"${READ_SCOPE}"`) }]);
      }
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });
  it.each<{ enabled: readonly OptionalTool[] }>([{ enabled: [] }, { enabled: ['capture_conversation'] },
    { enabled: ['log_meal'] }, { enabled: ['log_decision'] }, { enabled: OPTIONAL_TOOLS }])(
    'registers only explicitly enabled optional tools: $enabled', async ({ enabled }) => {
      const server = createServer(fixtureEnv({ ENABLED_TOOLS: enabled.join(',') }));
      const client = new Client({ name: 'module-test', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const listed = await client.listTools();
        expect(listed.tools.map(tool => tool.name).sort()).toEqual([...core, ...enabled].sort());
        for (const tool of listed.tools) expect(tool.description).not.toMatch(/[㐀-鿿]/);
        for (const tool of OPTIONAL_TOOLS.filter(tool => !enabled.includes(tool))) {
          await expect(client.callTool({ name: tool, arguments: {} })).rejects.toMatchObject({ code: -32602 });
        }
      } finally { await client.close(); await server.close(); }
    });

  it('blocks disabled service methods and raw writes without fetching', async () => {
    const fixture = new RepositoryFixture();
    const service = fixture.service([]);
    const capture = { source: 'test', conversation_id: 'c', batch_id: 'b', captured_at: '2026-01-03T09:00:00Z',
      messages: [{ role: 'user' as const, text: 'Synthetic selection' }] };
    await expect(service.capture(capture)).rejects.toMatchObject({ code: 'tool_disabled' });
    await expect(service.logMeal({ items: ['Synthetic meal'] })).rejects.toMatchObject({ code: 'tool_disabled' });
    await expect(service.logDecision({ question: 'Synthetic choice', data_used: [], ai_analysis: 'Suggestion', my_decision: 'Choose A' }))
      .rejects.toMatchObject({ code: 'tool_disabled' });
    for (const path of ['raw/conversations/2026-01/b.jsonl', 'data/meals/2026-01.jsonl', 'decisions/2026-01-03-choice.md']) {
      await expect(service.repo.put(path, 'Synthetic', undefined, 'fixture')).rejects.toMatchObject({ code: 'write_path_not_allowed' });
    }
    expect(fixture.requests).toHaveLength(0);
  });

  it('retains access to stored sources when capture is disabled', async () => {
    const fixture = new RepositoryFixture();
    fixture.set('raw/conversations/2026-01/b.jsonl', 'Synthetic selection');
    const service = fixture.service([]);
    expect((await service.read('raw/conversations/2026-01/b.jsonl')).text).toBe('Synthetic selection');
    expect((await service.search('selection')).matches).toHaveLength(1);
  });

  it('enables capture writes without enabling domain writes', async () => {
    const fixture = new RepositoryFixture();
    const service = fixture.service(['capture_conversation'], 'UTC');
    const result = await service.capture({ source: 'test', conversation_id: 'c', batch_id: 'b', captured_at: '2026-01-03T09:00:00Z',
      messages: [{ role: 'user', text: 'Synthetic selection' }] });
    const meta = JSON.parse(fixture.files.get(result.path)!.text.split('\n')[0]);
    expect(meta).toMatchObject({ coverage: 'partial', capture_scope: 'available_visible_messages', representation: 'source_text', redaction: 'none' });
    await expect(service.repo.put('data/meals/2026-01.jsonl', 'Synthetic', undefined, 'fixture')).rejects.toMatchObject({ code: 'write_path_not_allowed' });
    expect(fixture.commits).toBe(1);
  });
});
