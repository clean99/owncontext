import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, diagnoseFailure, diagnoseHealth, runDoctor } from '../src/cli/doctor';
import { ToolFailure } from '../src/cli/round-trip';
import { ALL_SCOPES, httpFixture, ORIGIN } from './support/http';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('doctor diagnostics', () => {
  it('provides actionable configuration, scope, repository and deployment failures', () => {
    expect(diagnoseHealth(503, null, 'build').code).toBe('missing-config');
    expect(diagnoseHealth(404, null, 'build').code).toBe('stale-deploy');
    expect(diagnoseHealth(200, { name: 'owncontext', build_id: 'old' }, 'build').code).toBe('stale-deploy');
    expect(diagnoseHealth(200, { name: 'owncontext', build_id: 'build' }, 'build').ok).toBe(true);
    expect(diagnoseFailure(new ToolFailure(403, 'insufficient_scope')).message).toContain('write checkbox');
    expect(diagnoseFailure(new ToolFailure(404, 'github_request_failed')).code).toBe('repository-unreachable');
    expect(diagnoseFailure(new ToolFailure(401, 'mcp_http_error')).code).toBe('authentication');
    expect(diagnoseFailure(new ToolFailure(503, 'required_context_missing')).code).toBe('missing-template');
    expect(diagnoseFailure(new Error('synthetic-secret')).message).not.toContain('synthetic-secret');
  });
  it('does not request anything without an origin or send credentials on health requests', async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ name: 'owncontext', build_id: 'build' }));
    const connector = vi.fn(connect);
    const deps = { request, connect: connector, runId: () => 'test' };
    expect((await runDoctor({ expectedBuild: 'build' }, deps))[0].code).toBe('missing-config');
    expect(request).not.toHaveBeenCalled();
    const results = await runDoctor({ origin: ORIGIN, expectedBuild: 'build' }, deps);
    expect(results.at(-1)?.code).toBe('missing-token');
    expect(connector).not.toHaveBeenCalled();
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(request.mock.calls[0][1]?.headers).toBeUndefined();
  });
  it('stops before authenticated requests to a stale or incorrect endpoint', async () => {
    const connector = vi.fn(connect);
    const results = await runDoctor({ origin: ORIGIN, token: 'synthetic-secret', expectedBuild: 'new' }, {
      request: async () => Response.json({ name: 'owncontext', build_id: 'old' }), connect: connector, runId: () => 'test',
    });
    expect(results[0].code).toBe('stale-deploy');
    expect(connector).not.toHaveBeenCalled();
  });
});

describe('doctor against the actual Worker handler with fake GitHub and OAuth KV', () => {
  async function fixture(write = false) {
    const app = httpFixture({ BUILD_ID: 'build' });
    app.repository.set('raw/snippets/preferences.md', await readFile(join(process.cwd(), 'templates/knowledge/raw/snippets/preferences.md'), 'utf8'));
    const credentials = await app.connect(write ? { scope: ALL_SCOPES, write: true } : {});
    const request: typeof fetch = (input, init) => {
      const req = new Request(input, init);
      expect(req.url.startsWith(ORIGIN)).toBe(true);
      return app.send(req);
    };
    return { app, credentials, dependencies: { request, connect, runId: () => 'synthetic-test' } };
  }
  it('exposes only public build metadata and performs zero writes by default', async () => {
    const { app, credentials, dependencies } = await fixture();
    const health = await app.send(new Request(`${ORIGIN}/health`));
    expect(await health.json()).toEqual({ name: 'owncontext', version: '0.1.0', build_id: 'build' });
    expect(health.headers.get('Cache-Control')).toBe('no-store');
    const results = await runDoctor({ origin: ORIGIN, token: credentials.access_token, expectedBuild: 'build' }, dependencies);
    expect(results.every(result => result.ok), JSON.stringify(results)).toBe(true);
    expect(results.map(result => result.code)).toEqual(['deployment', 'repository', 'read-only']);
    expect(app.repository.commits).toBe(0);
    expect(JSON.stringify(results)).not.toContain('A test profile.');
    await app.drain();
  });
  it('runs the acceptance flow through real MCP serialization and keeps the synthetic correction', async () => {
    const { app, credentials, dependencies } = await fixture(true);
    const results = await runDoctor({ origin: ORIGIN, token: credentials.access_token, expectedBuild: 'build', acceptance: true }, dependencies);
    expect(results.every(result => result.ok), JSON.stringify(results)).toBe(true);
    expect(results.at(-1)?.code).toBe('acceptance');
    expect(app.repository.commits).toBe(2);
    expect(app.repository.files.get('topics/owncontext-acceptance-synthetic-test.md')?.text).toContain('I prefer concise paragraphs.');
    expect(app.repository.files.has('me/preferences.md')).toBe(true);
    await app.drain();
  });
  it('reports missing write consent instead of claiming acceptance passed', async () => {
    const { app, credentials, dependencies } = await fixture();
    const results = await runDoctor({ origin: ORIGIN, token: credentials.access_token, expectedBuild: 'build', acceptance: true }, dependencies);
    expect(results.at(-1)?.code, JSON.stringify(results)).toBe('wrong-scopes');
    expect(app.repository.commits).toBe(0);
    await app.drain();
  });
  it('distinguishes repository credential expiry from MCP authentication failures', async () => {
    const { app, credentials, dependencies } = await fixture();
    vi.spyOn(app.repository, 'fetch').mockResolvedValue(new Response('synthetic-upstream-detail', { status: 401 }));
    const check = (token: string) => runDoctor({ origin: ORIGIN, token, expectedBuild: 'build' }, dependencies);
    for (const token of [credentials.access_token, (await app.connect()).access_token]) {
      const results = await check(token);
      expect(results.at(-1)?.code).toBe('repository-unreachable');
      expect(results.at(-1)?.message).toContain('OWNCONTEXT_GITHUB_TOKEN');
      expect(results.at(-1)?.message).not.toContain('OWNCONTEXT_ACCESS_TOKEN');
      expect(JSON.stringify(results)).not.toContain('synthetic-upstream-detail');
    }
    const unauthenticated = await check(`${credentials.access_token}tampered`);
    expect(unauthenticated.at(-1)?.code).toBe('authentication');
    expect(unauthenticated.at(-1)?.message).toContain('OWNCONTEXT_ACCESS_TOKEN');
    expect(app.repository.commits).toBe(0);
    await app.drain();
  });
  it('detects inaccessible repositories without disclosing upstream responses', async () => {
    const { app, credentials, dependencies } = await fixture();
    app.repository.privateRepo = false;
    const results = await runDoctor({ origin: ORIGIN, token: credentials.access_token, expectedBuild: 'build' }, dependencies);
    expect(results.at(-1)?.code).toBe('repository-unreachable');
    expect(app.repository.commits).toBe(0);
    await app.drain();
  });
});
