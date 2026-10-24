import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubRepository } from '../src/github';
import { ALL_SCOPES, ORIGIN, READ_SCOPE, READ_SCOPES, WRITE_SCOPE, cookie, httpFixture, type Credentials } from './support/http';

const writeCalls: [string, Record<string, unknown>][] = [
  ['remember', { path: 'topics/garden.md', fact: 'Use a small planter.', source: 'stated', source_ref: 'raw/snippets/garden.md' }],
  ['update_note', { path: 'topics/garden.md', name: 'Garden', description: 'Synthetic garden plan', body: '- [stated] Use a small planter.', expected_sha: null }],
  ['capture_conversation', { source: 'fixture', conversation_id: 'garden', batch_id: 'first', captured_at: '2026-01-03T09:00:00Z', messages: [{ role: 'user', text: 'Use a small planter.' }] }],
  ['log_meal', { items: ['Synthetic lunch'], time: '2026-01-03T12:00:00Z', request_id: 'lunch' }],
  ['log_decision', { question: 'Which planter?', data_used: [], ai_analysis: 'A small one fits.', my_decision: 'Use a small planter.', request_id: 'planter', recorded_on: '2026-01-03' }],
];

function adapterSpies() {
  return (['tree', 'read', 'put', 'mutate'] as const).map(method => vi.spyOn(GitHubRepository.prototype, method));
}

function expectNoAdapterCalls(f: ReturnType<typeof httpFixture>, spies: ReturnType<typeof adapterSpies>) {
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(f.repository.requests).toHaveLength(0);
  expect(f.repository.commits).toBe(0);
}

function expectWriteDenied(result: Awaited<ReturnType<ReturnType<typeof httpFixture>['call']>>) {
  expect(result.response.status).toBe(200);
  expect(result.body.result?.isError).toBe(true);
  expect(result.data).toMatchObject({ status: 403, error: 'insufficient_scope', required_scope: WRITE_SCOPE });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('production HTTP entry: OAuth to MCP authorization boundary', () => {
  it('keeps repository and account identifiers out of anonymous consent responses', async () => {
    const f = httpFixture({ GITHUB_OWNER: 'synthetic-private-owner', GITHUB_REPO: 'synthetic-private-notes',
      ALLOWED_GITHUB_LOGIN: 'synthetic-private-login', ALLOWED_GITHUB_ID: '87654321' });
    const auth = await f.begin();
    expect(auth.html).toContain('Read-only by default');
    expect(auth.html).toContain(READ_SCOPE);
    expect(auth.html).toContain(WRITE_SCOPE);
    for (const value of [f.env.GITHUB_OWNER, f.env.GITHUB_REPO, f.env.ALLOWED_GITHUB_LOGIN, f.env.ALLOWED_GITHUB_ID])
      expect(auth.html).not.toContain(value);
    expect(f.upstream).not.toHaveBeenCalled();
    expect(f.repository.requests).toHaveLength(0);
    await f.drain();
  });

  it.each([null, '', READ_SCOPES, ALL_SCOPES])('defaults the initial connection to read-only, requested scope=%s', async scope => {
    const f = httpFixture();
    const credentials = await f.connect({ scope });
    expect(credentials.scope.split(' ').sort()).toEqual(READ_SCOPES.split(' ').sort());
    expect(credentials.refresh_token).toBeTruthy();
    const initialized = await f.rpc(credentials.access_token, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic-client', version: '1.0.0' },
    });
    expect(initialized.response.status).toBe(200);
    expect(initialized.body.error).toBeUndefined();
    expect(initialized.body.result?.protocolVersion).toBeTruthy();
    for (const [name, args] of [['read', { path: 'me/profile.md' }], ['search', { query: 'Synthetic' }], ['get_context', {}]] as const) {
      const result = await f.call(credentials.access_token, name, args);
      expect(result.response.status).toBe(200);
      expect(result.body.result?.isError, name).not.toBe(true);
      expect(result.data, name).toBeDefined();
      if (name === 'read') expect(result.data!.text).toContain('A test profile.');
    }
    expect(f.repository.requests.length).toBeGreaterThan(0);
    expect(f.repository.commits).toBe(0);
    await f.drain();
  });

  it('does not preselect write consent from any client authorization parameters', async () => {
    const f = httpFixture();
    const auth = await f.begin(ALL_SCOPES, undefined, { grant_write: 'yes', decision: 'approve' });
    expect(auth.html).toContain('Read-only');
    expect(auth.html).toMatch(/type="checkbox"[^>]*name="grant_write"[^>]*value="yes"/);
    expect(auth.html).not.toMatch(/\bchecked(?:\s|=|>)/);
    expect(auth.html).toContain(WRITE_SCOPE);
    const code = await f.finish(await f.approve(auth, { scope: ALL_SCOPES }));
    const response = await f.exchange(auth.clientId, code, { scope: ALL_SCOPES });
    const credentials = await response.json() as Credentials;
    expect(response.status).toBe(200);
    expect(credentials.scope).not.toContain(WRITE_SCOPE);
  });

  it.each(writeCalls)('rejects read-only calls to %s before any knowledge adapter method', async (name, args) => {
    const f = httpFixture();
    const credentials = await f.connect({ scope: ALL_SCOPES });
    const spies = adapterSpies();
    expectWriteDenied(await f.call(credentials.access_token, name, args));
    expectNoAdapterCalls(f, spies);
  });

  it('covers the entire advertised writing surface, including enabled optional modules', async () => {
    const f = httpFixture();
    const credentials = await f.connect();
    const spies = adapterSpies();
    const listed = await f.rpc(credentials.access_token, 'tools/list');
    expect(listed.body.result?.tools?.map(tool => tool.name).sort()).toEqual([
      'get_context', 'read', 'search', ...writeCalls.map(([name]) => name),
    ].sort());
    for (const [name, args] of writeCalls) expectWriteDenied(await f.call(credentials.access_token, name, args));
    expectNoAdapterCalls(f, spies);
  });

  it.each(writeCalls)('allows deliberately write-scoped tokens to invoke %s', async (name, args) => {
    const f = httpFixture();
    const initial = await f.connect();
    expect(initial.scope).not.toContain(WRITE_SCOPE);
    const credentials = await f.connect({ clientId: initial.clientId, scope: ALL_SCOPES, write: true });
    expect(credentials.scope.split(' ')).toContain(WRITE_SCOPE);
    const result = await f.call(credentials.access_token, name, args);
    expect(result.response.status).toBe(200);
    expect(result.body.result?.isError).not.toBe(true);
    expect(result.data).toMatchObject({ unchanged: false });
    expect(f.repository.commits).toBe(1);
  });

  it('rejects a write-consent POST from a different origin even with the browser cookie', async () => {
    const f = httpFixture();
    const auth = await f.begin(ALL_SCOPES);
    const response = await f.approve(auth, { grant_write: 'yes' }, { Cookie: cookie(auth.page), Origin: 'https://attacker.example' });
    expect(response.status).toBe(400);
    expect(f.upstream).not.toHaveBeenCalled();
    expect(f.repository.requests).toHaveLength(0);
  });

  it('rejects write consent without the browser-bound transaction and cannot replay consent or callbacks', async () => {
    const f = httpFixture();
    const auth = await f.begin(ALL_SCOPES);
    const forged = await f.approve(auth, { grant_write: 'yes' }, { Origin: ORIGIN });
    expect(forged.status).toBe(400);
    const approved = await f.approve(auth, { grant_write: 'yes' });
    const replay = await f.approve(auth, { grant_write: 'yes' });
    expect(replay.status).toBe(400);
    await f.finish(approved);
    const before = f.upstream.mock.calls.length;
    const state = new URL(approved.headers.get('Location')!).searchParams.get('state')!;
    const callback = await f.send(new Request(`${ORIGIN}/callback?code=fixture-code&state=${state}`, { headers: { Cookie: cookie(approved) } }));
    expect(callback.status).toBe(400);
    expect(f.upstream).toHaveBeenCalledTimes(before);
  });

  it('cannot escalate in the token exchange, refresh, or MCP arguments and metadata', async () => {
    const f = httpFixture();
    const credentials = await f.connect({ scope: ALL_SCOPES, fields: { scope: ALL_SCOPES }, tokenFields: { scope: ALL_SCOPES } });
    expect(credentials.scope).not.toContain(WRITE_SCOPE);
    const refreshed = await f.refresh(credentials, { scope: ALL_SCOPES });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json() as Credentials;
    expect(next.scope).not.toContain(WRITE_SCOPE);
    const spies = adapterSpies();
    const [name, args] = writeCalls[0];
    expectWriteDenied(await f.call(next.access_token, name, { ...args, scope: ALL_SCOPES, grant_write: 'yes' }, {
      scope: ALL_SCOPES, _meta: { scope: ALL_SCOPES, auth: { scope: [READ_SCOPE, WRITE_SCOPE] } },
    }));
    expectNoAdapterCalls(f, spies);
  });

  it('refuses a write-only scope request on a read grant at exchange and refresh', async () => {
    const f = httpFixture();
    const auth = await f.begin(ALL_SCOPES);
    const code = await f.finish(await f.approve(auth));
    const exchange = await f.exchange(auth.clientId, code, { scope: WRITE_SCOPE });
    expect(exchange.status).toBe(400);
    expect(await exchange.json()).toMatchObject({ error: 'invalid_scope' });
    const credentials = await f.connect();
    const refresh = await f.refresh(credentials, { scope: WRITE_SCOPE });
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: 'invalid_scope' });
  });

  it('uses the effective downscoped token, not the original write grant', async () => {
    const f = httpFixture();
    const credentials = await f.connect({ write: true, tokenFields: { scope: READ_SCOPES } });
    expect(credentials.scope).not.toContain(WRITE_SCOPE);
    const spies = adapterSpies();
    expectWriteDenied(await f.call(credentials.access_token, ...writeCalls[0]));
    expectNoAdapterCalls(f, spies);
  });

  it.each(['expired', 'revoked-access', 'revoked-grant', 'tampered'] as const)('rejects %s tokens on both read and write calls with zero adapter calls', async kind => {
    const f = httpFixture();
    const credentials = await f.connect({ write: true });
    if (kind === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + (credentials.expires_in + 1) * 1000);
    if (kind === 'revoked-access') expect((await f.revoke(credentials, 'access_token')).status).toBe(200);
    if (kind === 'revoked-grant') {
      expect((await f.revoke(credentials, 'refresh_token')).status).toBe(200);
      const refresh = await f.refresh(credentials);
      expect(refresh.status).toBe(400);
      expect(await refresh.json()).toMatchObject({ error: 'invalid_grant' });
    }
    const token = kind === 'tampered' ? `${credentials.access_token}tampered` : credentials.access_token;
    const spies = adapterSpies();
    for (const [name, args] of [['read', { path: 'me/profile.md' }], ...writeCalls] as [string, Record<string, unknown>][]) {
      const result = await f.call(token, name, args);
      expect(result.response.status, name).toBe(401);
      expect(result.response.headers.get('WWW-Authenticate')).toContain('Bearer');
    }
    expectNoAdapterCalls(f, spies);
  });

  it('rejects expired refresh tokens and tokens without the required read scope', async () => {
    const f = httpFixture();
    const credentials = await f.connect({ write: true, tokenFields: { scope: WRITE_SCOPE } });
    const spies = adapterSpies();
    const result = await f.call(credentials.access_token, ...writeCalls[0]);
    expect(result.response.status).toBe(403);
    expect(result.response.headers.get('WWW-Authenticate')).toContain(READ_SCOPE);
    expectNoAdapterCalls(f, spies);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2_592_001 * 1000);
    const refreshed = await f.refresh(credentials);
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('enforces audience, client binding, PKCE and authorization-code replay protection', async () => {
    const f = httpFixture();
    const auth = await f.begin();
    const code = await f.finish(await f.approve(auth));
    const wrongPkce = await f.exchange(auth.clientId, code, { code_verifier: 'b'.repeat(43) });
    expect(wrongPkce.status).toBe(400);
    const wrongAudience = await f.exchange(auth.clientId, code, { resource: 'https://other.example/mcp' });
    expect(wrongAudience.status).toBe(400);
    const otherClient = await f.begin();
    const wrongClient = await f.exchange(otherClient.clientId, code);
    expect(wrongClient.status).toBe(400);
    const token = await f.exchange(auth.clientId, code);
    expect(token.status).toBe(200);
    const replay = await f.exchange(auth.clientId, code);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
    expect(f.repository.requests).toHaveLength(0);
  });
});

describe('production HTTP entry: write contracts', () => {
  it.each(['update_note', 'remember'])('rejects NUL content through %s without making a commit', async name => {
    const f = httpFixture();
    const credentials = await f.connect({ write: true });
    const path = 'me/preferences.md';
    const original = { ...f.repository.files.get(path)! };
    const args = name === 'update_note'
      ? { path, name: 'Preferences', description: 'Synthetic preferences', body: 'Invalid\u0000content', expected_sha: original.sha }
      : { path, fact: 'Invalid\u0000content', source: 'stated' };
    const result = await f.call(credentials.access_token, name, args);
    expect(result.body.result?.isError).toBe(true);
    expect(result.data).toMatchObject({ status: 415, error: 'binary_content' });
    expect(f.repository.commits).toBe(0);
    expect(f.repository.requests.some(request => request.init?.method === 'PUT')).toBe(false);
    expect(f.repository.files.get(path)).toEqual(original);
    const read = await f.call(credentials.access_token, 'read', { path });
    expect(read.data).toMatchObject({ sha: original.sha, text: original.text });
    const context = await f.call(credentials.access_token, 'get_context', {});
    expect(context.body.result?.isError).not.toBe(true);
    await f.drain();
  });

  it.each(['update_note', 'remember'])('preserves large integer source identifiers through %s', async name => {
    const f = httpFixture();
    const path = 'me/preferences.md';
    f.repository.set(path, `---
name: Preferences
description: Synthetic preferences
source_message_id: 9007199254740993
sources:
  primary: 1234567890123456789
  related: [9007199254740995, -9007199254740993]
revision: 42
---

- [stated] Original preference.
`);
    const credentials = await f.connect({ write: true });
    const args = name === 'update_note'
      ? { path, name: 'Preferences', description: 'Synthetic preferences', body: '- [stated] Revised preference.',
        expected_sha: f.repository.files.get(path)!.sha }
      : { path, fact: 'Revised preference.', source: 'stated' };
    const result = await f.call(credentials.access_token, name, args);
    expect(result.body.result?.isError).not.toBe(true);
    expect(result.data).toMatchObject({ unchanged: false });
    const read = await f.call(credentials.access_token, 'read', { path });
    const text = String(read.data!.text);
    expect(text).toContain('source_message_id: 9007199254740993');
    expect(text).toContain('primary: 1234567890123456789');
    expect(text).toContain('9007199254740995');
    expect(text).toContain('-9007199254740993');
    expect(text).toContain('revision: 42');
    expect(text).toContain('Revised preference.');
    const repeated = await f.call(credentials.access_token, name, args);
    expect(repeated.data).toMatchObject({ unchanged: true, sha: result.data!.sha });
    expect(f.repository.commits).toBe(1);
    const context = await f.call(credentials.access_token, 'get_context', { mode: 'full' });
    expect(context.body.result?.isError).not.toBe(true);
    await f.drain();
  });

  it('keeps full context JSON-safe when metadata dates are not strings', async () => {
    const f = httpFixture();
    f.repository.set('topics/metadata.md', `---
name: Synthetic metadata
description: Synthetic source identifiers
updated: 20261012
review_on:
  source_message_id: 9007199254740993
---

Synthetic note.
`);
    const credentials = await f.connect();
    const result = await f.call(credentials.access_token, 'get_context', { mode: 'full' });
    expect(result.body.result?.isError).not.toBe(true);
    const index = result.data!.index as Record<string, unknown>[];
    expect(index.find(entry => entry.path === 'topics/metadata.md')).toEqual({
      path: 'topics/metadata.md', description: 'Synthetic source identifiers', needs_review: false,
    });
    expect(f.repository.commits).toBe(0);
    await f.drain();
  });

  it('keeps SHA preconditions and rejects concurrent updates without overwriting', async () => {
    const f = httpFixture();
    const credentials = await f.connect({ write: true });
    const [, args] = writeCalls[1];
    const created = await f.call(credentials.access_token, 'update_note', args);
    expect(created.data).toMatchObject({ unchanged: false });
    const read = await f.call(credentials.access_token, 'read', { path: args.path });
    const updated = await f.call(credentials.access_token, 'update_note', { ...args, expected_sha: read.data!.sha, body: '- [stated] Choose a larger planter.' });
    expect(updated.data).toMatchObject({ unchanged: false });
    const stale = await f.call(credentials.access_token, 'update_note', { ...args, expected_sha: read.data!.sha, body: '- [stated] Stale replacement.' });
    expect(stale.body.result?.isError).toBe(true);
    expect(stale.data).toMatchObject({ status: 409, error: 'note_changed_read_and_merge' });
    const createAgain = await f.call(credentials.access_token, 'update_note', args);
    expect(createAgain.data).toMatchObject({ status: 409 });
    expect(f.repository.commits).toBe(2);
    expect(f.repository.files.get(String(args.path))!.text).toContain('Choose a larger planter.');
    const put = f.repository.requests.filter(request => request.init?.method === 'PUT').at(-1)!;
    expect(JSON.parse(String(put.init!.body)).sha).toBe(read.data!.sha);
  });

  it.each(writeCalls)('keeps retries idempotent for %s', async (name, args) => {
    const f = httpFixture();
    const credentials = await f.connect({ write: true });
    const first = await f.call(credentials.access_token, name, args);
    expect(first.body.result?.isError).not.toBe(true);
    const repeated = await f.call(credentials.access_token, name, args);
    expect(repeated.data).toMatchObject({ unchanged: true, sha: first.data!.sha });
    expect(f.repository.commits).toBe(1);
  });

  it('rejects a capture stable-key collision instead of changing the stored source', async () => {
    const f = httpFixture();
    const credentials = await f.connect({ write: true });
    const [name, args] = writeCalls[2];
    const first = await f.call(credentials.access_token, name, args);
    const before = f.repository.files.get(String(first.data!.path))!.text;
    const collision = await f.call(credentials.access_token, name, { ...args, messages: [{ role: 'user', text: 'Different selection.' }] });
    expect(collision.body.result?.isError).toBe(true);
    expect(collision.data).toMatchObject({ status: 409 });
    expect(f.repository.files.get(String(first.data!.path))!.text).toBe(before);
    expect(f.repository.commits).toBe(1);
  });
});
