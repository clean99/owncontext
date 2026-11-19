import { afterEach, describe, expect, it, vi } from 'vitest';
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { consentPage, handleAuthorization, limitRequestBody } from '../src/auth';
import { READ_SCOPE, AUTH_SCOPES, READ_ONLY_SCOPES, isAllowedIdentity, type Env } from '../src/env';

import { fixtureEnv, MemoryKv } from './support/env';

const ORIGIN = 'https://owncontext.example';
const REDIRECT = 'https://client.example/callback';
const VERIFIER = 'a'.repeat(43);

function fixture(overrides: Partial<Env> = {}) {
  const kv = new MemoryKv();
  const env = fixtureEnv({ OAUTH_KV: kv as unknown as KVNamespace, OWNCONTEXT_GITHUB_TOKEN: 'repository-token-must-not-enter-auth', ...overrides });
  const provider = new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: { fetch: (_request, _env, ctx) => Response.json(ctx.props) },
    defaultHandler: { fetch: handleAuthorization },
    authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: AUTH_SCOPES, requiredScopes: [READ_SCOPE],
    resourceMetadata: { resource: `${ORIGIN}/mcp` },
  });
  const send = (request: Request) => provider.fetch(request, env, {
    props: {}, waitUntil: () => {}, passThroughOnException: () => {},
  } as unknown as ExecutionContext);
  return { env, kv, send };
}

function cookie(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
}

async function begin(f: ReturnType<typeof fixture>, redirect = REDIRECT, scope: string | null = AUTH_SCOPES.join(' ')) {
  const registration = await f.send(new Request(`${ORIGIN}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Personal client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  }));
  expect(registration.status).toBe(201);
  const client = await registration.json() as { client_id: string };
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(VERIFIER)));
  const challenge = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const query = new URLSearchParams({ client_id: client.client_id, response_type: 'code', redirect_uri: redirect, state: 'client-state', resource: `${ORIGIN}/mcp`, code_challenge: challenge, code_challenge_method: 'S256' });
  if (scope !== null) query.set('scope', scope);
  const page = await f.send(new Request(`${ORIGIN}/authorize?${query}`));
  const body = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(body)?.[1];
  return { page, body, handle, clientId: client.client_id };
}

async function approve(f: ReturnType<typeof fixture>, scope: string | null = AUTH_SCOPES.join(' ')) {
  const auth = await begin(f, REDIRECT, scope);
  expect(auth.page.status).toBe(200);
  const response = await f.send(new Request(`${ORIGIN}/authorize`, {
    method: 'POST', headers: { Cookie: cookie(auth.page), Origin: ORIGIN },
    body: new URLSearchParams({ handle: auth.handle!, decision: 'approve' }),
  }));
  expect(response.status).toBe(302);
  return { ...auth, response, upstream: new URL(response.headers.get('Location')!) };
}

function mockGitHub(identity = { id: 12345678, login: 'sample-user' }, scope = '') {
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    if (String(url) === 'https://github.com/login/oauth/access_token') {
      return Response.json({ access_token: 'identity-token', token_type: 'bearer', scope });
    }
    if (String(url) === 'https://api.github.com/user') return Response.json(identity);
    throw new Error('Unexpected external request');
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('OAuth authorization', () => {
  it('limits streamed bodies even when Content-Length lies, and cancels the stream', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(9)); },
      cancel,
    });
    const request = new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'Content-Length': '1' }, body: stream, duplex: 'half' } as RequestInit);
    const response = await limitRequestBody(request, 8);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(413);
    expect(cancel).toHaveBeenCalled();
  });

  it('preserves allowed request content, URL and headers after bounded reading', async () => {
    const request = new Request(`${ORIGIN}/mcp`, { method: 'POST', body: '12345678', headers: { Authorization: 'Bearer test', 'Mcp-Protocol-Version': '2025-06-18' } });
    const bounded = await limitRequestBody(request, 8);
    expect(bounded).toBeInstanceOf(Request);
    expect(await bounded.text()).toBe('12345678');
    expect((bounded as Request).url).toBe(request.url);
    expect(bounded.headers.get('Authorization')).toBe('Bearer test');
    expect(bounded.headers.get('Mcp-Protocol-Version')).toBe('2025-06-18');
  });

  it.each([
    { label: 'all advertised scopes', scope: AUTH_SCOPES.join(' ') },
    { label: 'only the resource scope', scope: READ_SCOPE },
    { label: 'an omitted scope parameter', scope: null },
    { label: 'an empty scope parameter', scope: '' },
  ])('completes consent, PKCE and refresh with $label', async ({ scope }) => {
    const f = fixture();
    const auth = await approve(f, scope);
    expect(auth.body).toContain(`Permissions: ${READ_ONLY_SCOPES.join(', ')}`);
    expect(auth.page.headers.get('X-Frame-Options')).toBe('DENY');
    expect(cookie(auth.page)).toContain('__Host-');
    expect(auth.upstream.origin).toBe('https://github.com');
    expect(auth.upstream.searchParams.get('scope')).toBe('');
    expect(auth.upstream.searchParams.get('code_challenge_method')).toBe('S256');
    const github = mockGitHub();
    const callback = await f.send(new Request(`${ORIGIN}/callback?${new URLSearchParams({ code: 'github-code', state: auth.upstream.searchParams.get('state')! })}`, { headers: { Cookie: cookie(auth.response) } }));
    expect(callback.status).toBe(302);
    const redirect = new URL(callback.headers.get('Location')!);
    expect(redirect.origin).toBe('https://client.example');
    expect(redirect.searchParams.get('state')).toBe('client-state');
    expect(redirect.searchParams.get('iss')).toBe(ORIGIN);
    expect(github).toHaveBeenCalledTimes(2);
    const tokenRequest = github.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(tokenRequest[1].headers).get('User-Agent')).toBe('owncontext');
    expect(String(tokenRequest[1].body)).not.toContain(f.env.OWNCONTEXT_GITHUB_TOKEN);
    expect(new URLSearchParams(String(tokenRequest[1].body)).get('code_verifier')).toHaveLength(72);
    const token = await f.send(new Request(`${ORIGIN}/oauth/token`, {
      method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: auth.clientId, code: redirect.searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: `${ORIGIN}/mcp` }),
    }));
    expect(token.status).toBe(200);
    const credentials = await token.json() as { access_token: string; refresh_token: string; scope: string };
    expect(credentials.scope.split(' ')).toEqual(READ_ONLY_SCOPES);
    expect(credentials.refresh_token).toBeTruthy();
    const api = await f.send(new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${credentials.access_token}` } }));
    expect(await api.json()).toEqual({ githubId: '12345678', githubLogin: 'sample-user' });
    expect([...f.kv.records.values()].join('')).not.toContain('identity-token');
    const refreshed = await f.send(new Request(`${ORIGIN}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: auth.clientId, refresh_token: credentials.refresh_token, resource: `${ORIGIN}/mcp` }) }));
    expect(refreshed.status).toBe(200);
  });

  it('completes OAuth for a separately configured identity and repository', async () => {
    const f = fixture({ ALLOWED_GITHUB_LOGIN: 'second-user', ALLOWED_GITHUB_ID: '87654321',
      GITHUB_OWNER: 'second-user', GITHUB_REPO: 'second-notes' });
    const auth = await approve(f);
    expect(auth.body).not.toContain('second-user');
    expect(auth.body).not.toContain('second-notes');
    expect(auth.body).not.toContain('sample-user');
    mockGitHub({ id: 87654321, login: 'second-user' });
    const response = await f.send(new Request(`${ORIGIN}/callback?code=code&state=${auth.upstream.searchParams.get('state')}`, { headers: { Cookie: cookie(auth.response) } }));
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('Location')!).searchParams.get('code')).toBeTruthy();
  });

  it('preserves the browser Origin on same-origin consent form submissions', async () => {
    const f = fixture();
    const auth = await begin(f);
    // no-referrer makes browser form POSTs send Origin: null, even to the same origin.
    expect(auth.page.headers.get('Referrer-Policy')).toBe('same-origin');
    const response = await f.send(new Request(`${ORIGIN}/authorize`, {
      method: 'POST', headers: { Cookie: cookie(auth.page), Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' },
      body: new URLSearchParams({ handle: auth.handle!, decision: 'approve' }),
    }));
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('Location')!).origin).toBe('https://github.com');
  });

  it.each(['null', 'https://attacker.example'])('rejects consent from Origin %s even with a valid cookie and handle', async origin => {
    const f = fixture();
    const auth = await begin(f);
    const response = await f.send(new Request(`${ORIGIN}/authorize`, {
      method: 'POST', headers: { Cookie: cookie(auth.page), Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
      body: new URLSearchParams({ handle: auth.handle!, decision: 'approve' }),
    }));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Authorization form must be submitted from this server.');
    expect(response.headers.get('Location')).toBeNull();
    expect([...f.kv.records.keys()].some(key => key.includes('upstream'))).toBe(false);
  });

  it('rejects a forged consent POST without its browser cookie', async () => {
    const f = fixture();
    const auth = await begin(f);
    const response = await f.send(new Request(`${ORIGIN}/authorize`, { method: 'POST', headers: { Origin: ORIGIN }, body: new URLSearchParams({ handle: auth.handle!, decision: 'approve' }) }));
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
  });

  it('rejects a callback from another browser before exchanging GitHub credentials', async () => {
    const f = fixture();
    const auth = await approve(f);
    const github = mockGitHub();
    const callback = await f.send(new Request(`${ORIGIN}/callback?code=stolen&state=${auth.upstream.searchParams.get('state')}`));
    expect(callback.status).toBe(400);
    expect(github).not.toHaveBeenCalled();
  });

  it('denies unregistered redirect URIs without an open redirect', async () => {
    const result = await begin(fixture(), 'https://attacker.example/callback');
    expect(result.page.status).toBe(400);
    expect(result.page.headers.get('Location')).toBeNull();
  });

  it('returns a denied consent to the validated client without starting GitHub sign-in', async () => {
    const f = fixture();
    const auth = await begin(f);
    const response = await f.send(new Request(`${ORIGIN}/authorize`, { method: 'POST', headers: { Cookie: cookie(auth.page) }, body: new URLSearchParams({ handle: auth.handle!, decision: 'deny' }) }));
    expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe('access_denied');
    expect([...f.kv.records.keys()].some((key) => key.includes('upstream'))).toBe(false);
  });

  it.each([{ id: 1, login: 'sample-user' }, { id: 12345678, login: 'someone-else' }])('refuses a GitHub identity that fails either allowlist field: %j', async (identity) => {
    const f = fixture();
    const auth = await approve(f);
    mockGitHub(identity);
    const response = await f.send(new Request(`${ORIGIN}/callback?code=code&state=${auth.upstream.searchParams.get('state')}`, { headers: { Cookie: cookie(auth.response) } }));
    expect(response.status).toBe(403);
    expect([...f.kv.records.keys()].some((key) => key.startsWith('grant:'))).toBe(false);
  });

  it('rejects a GitHub token carrying repository permissions', async () => {
    const f = fixture();
    const auth = await approve(f);
    const github = mockGitHub(undefined, 'repo');
    const response = await f.send(new Request(`${ORIGIN}/callback?code=code&state=${auth.upstream.searchParams.get('state')}`, { headers: { Cookie: cookie(auth.response) } }));
    expect(response.status).toBe(502);
    expect(github).toHaveBeenCalledTimes(1);
  });

  it.each([
    { stage: 'token', kind: 'network', expected: 'token_network' },
    { stage: 'token', kind: 'timeout', expected: 'token_timeout' },
    { stage: 'token', kind: 'http', expected: 'token_http_403' },
    { stage: 'token', kind: 'redirect', expected: 'token_http_302' },
    { stage: 'token', kind: 'json', expected: 'token_invalid_json' },
    { stage: 'token', kind: 'shape', expected: 'token_invalid_response' },
    { stage: 'identity', kind: 'network', expected: 'identity_network' },
    { stage: 'identity', kind: 'redirect', expected: 'identity_http_302' },
    { stage: 'identity', kind: 'json', expected: 'identity_invalid_json' },
    { stage: 'identity', kind: 'shape', expected: 'identity_invalid_response' },
  ])('fails closed with a private diagnostic for $expected', async ({ stage, kind, expected }) => {
    const f = fixture();
    const auth = await approve(f);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (stage === 'identity' && url.includes('/access_token')) {
        return Response.json({ access_token: 'secret-identity-token', token_type: 'bearer', scope: '' });
      }
      if (kind === 'network') throw new TypeError('secret-upstream-detail');
      if (kind === 'timeout') throw new DOMException('secret-upstream-detail', 'TimeoutError');
      if (kind === 'http') return new Response('secret-upstream-detail', { status: 403 });
      if (kind === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://attacker.example/' } });
      if (kind === 'shape') return Response.json(null);
      return new Response('secret-upstream-detail', { headers: { 'Content-Type': 'text/html' } });
    }));
    const response = await f.send(new Request(`${ORIGIN}/callback?code=secret-code&state=${auth.upstream.searchParams.get('state')}`, { headers: { Cookie: cookie(auth.response) } }));
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain(expected);
    expect(body).not.toContain('secret-');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect([...f.kv.records.keys()].some((key) => key.startsWith('grant:'))).toBe(false);
  });

  it('escapes client metadata in the consent page', () => {
    const html = consentPage({ clientId: 'client', clientName: '<script>alert(1)</script>', clientDomain: 'bad<domain', redirectUri: REDIRECT, redirectHost: '<evil>', redirectIsLoopback: true, scope: [] }, 'safe-handle', fixtureEnv());
    expect(html).not.toContain('<script>');
    expect(html).toContain('&#60;script&#62;');
    expect(html).toContain('application on your computer');
  });

  it('fails closed for missing props and a changed account allowlist', () => {
    const { env } = fixture();
    expect(isAllowedIdentity(undefined, env)).toBe(false);
    expect(isAllowedIdentity({ githubId: '12345678', githubLogin: 'sample-user' }, env)).toBe(true);
    expect(isAllowedIdentity({ githubId: '1', githubLogin: 'other' }, { ...env, ALLOWED_GITHUB_ID: '1', ALLOWED_GITHUB_LOGIN: 'other' })).toBe(true);
  });
});
