import { expect, vi } from 'vitest';
import worker from '../../src/index';
import { OPTIONAL_TOOLS, type Env } from '../../src/env';
import { fixtureEnv, MemoryKv } from './env';
import { RepositoryFixture } from './repository';

export const ORIGIN = 'https://owncontext.example';
export const RESOURCE = `${ORIGIN}/mcp`;
export const REDIRECT = 'https://client.example/callback';
export const VERIFIER = 'a'.repeat(43);
export const READ_SCOPE = 'owncontext:read';
export const WRITE_SCOPE = 'owncontext:write';
export const READ_SCOPES = `${READ_SCOPE} offline_access`;
export const ALL_SCOPES = `${READ_SCOPE} ${WRITE_SCOPE} offline_access`;

export function cookie(response: Response): string {
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}

export interface Credentials {
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_in: number;
  clientId: string;
}

interface RpcResponse {
  result?: { content?: { type: string; text: string }[]; isError?: boolean; tools?: { name: string }[]; protocolVersion?: string };
  error?: { code: number; message: string };
}

export function httpFixture(overrides: Partial<Env> = {}) {
  const kv = new MemoryKv();
  const repository = new RepositoryFixture();
  repository.seedContext();
  repository.set('me/profile.md', '---\nname: Synthetic profile\ndescription: Synthetic test context\n---\n\nA test profile.\n');
  const env = fixtureEnv({ OAUTH_KV: kv as unknown as KVNamespace, ENABLED_TOOLS: OPTIONAL_TOOLS.join(','), ...overrides });
  const upstream = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === 'https://github.com/login/oauth/access_token')
      return Response.json({ access_token: 'fixture-identity-token', token_type: 'bearer', scope: '' });
    if (url === 'https://api.github.com/user') return Response.json({ id: 12345678, login: 'sample-user' });
    if (url.startsWith('https://api.github.com/repos/sample-user/sample-notes')) return repository.fetch(input, init);
    throw new Error(`Unexpected outbound request: ${url}`);
  });
  vi.stubGlobal('fetch', upstream);
  const pending: Promise<unknown>[] = [];
  const send = (request: Request) => worker.fetch(request as Parameters<typeof worker.fetch>[0], env, {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {},
  } as ExecutionContext);
  const postForm = (path: string, form: Record<string, string>, headers?: HeadersInit) =>
    send(new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: new URLSearchParams(form) }));

  async function begin(scope: string | null = null, clientId?: string, extra: Record<string, string> = {}) {
    if (!clientId) {
      const registered = await send(new Request(`${ORIGIN}/oauth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Synthetic client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
      }));
      expect(registered.status).toBe(201);
      clientId = (await registered.json() as { client_id: string }).client_id;
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(VERIFIER));
    const challenge = Buffer.from(digest).toString('base64url');
    const query = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT, state: 'fixture-state',
      resource: RESOURCE, code_challenge: challenge, code_challenge_method: 'S256', ...extra });
    if (scope !== null) query.set('scope', scope);
    const page = await send(new Request(`${ORIGIN}/authorize?${query}`));
    const html = await page.text();
    expect(page.status, html).toBe(200);
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
    expect(handle).toBeTruthy();
    return { page, html, handle: handle!, clientId };
  }

  async function approve(auth: Awaited<ReturnType<typeof begin>>, fields: Record<string, string> = {}, headers?: HeadersInit) {
    return postForm('/authorize', { handle: auth.handle, decision: 'approve', ...fields }, headers ?? { Cookie: cookie(auth.page), Origin: ORIGIN });
  }

  async function finish(approved: Response) {
    expect(approved.status, await approved.clone().text()).toBe(302);
    const location = new URL(approved.headers.get('Location')!);
    const callback = await send(new Request(`${ORIGIN}/callback?${new URLSearchParams({ code: 'fixture-code', state: location.searchParams.get('state')! })}`,
      { headers: { Cookie: cookie(approved) } }));
    expect(callback.status, await callback.clone().text()).toBe(302);
    const redirect = new URL(callback.headers.get('Location')!);
    expect(redirect.origin).toBe(new URL(REDIRECT).origin);
    expect(redirect.searchParams.get('state')).toBe('fixture-state');
    return redirect.searchParams.get('code')!;
  }

  const exchange = (clientId: string, code: string, fields: Record<string, string> = {}) => postForm('/oauth/token', {
    grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: RESOURCE, ...fields,
  });

  async function connect(options: { scope?: string | null; write?: boolean; clientId?: string; fields?: Record<string, string>; tokenFields?: Record<string, string> } = {}): Promise<Credentials> {
    const auth = await begin(options.scope, options.clientId);
    const approved = await approve(auth, { ...(options.write ? { grant_write: 'yes' } : {}), ...options.fields });
    const code = await finish(approved);
    const response = await exchange(auth.clientId, code, options.tokenFields);
    expect(response.status, await response.clone().text()).toBe(200);
    return { ...await response.json() as Omit<Credentials, 'clientId'>, clientId: auth.clientId };
  }

  const refresh = (credentials: Credentials, fields: Record<string, string> = {}) => postForm('/oauth/token', {
    grant_type: 'refresh_token', client_id: credentials.clientId, refresh_token: credentials.refresh_token, resource: RESOURCE, ...fields,
  });
  const revoke = (credentials: Credentials, kind: 'access_token' | 'refresh_token') => postForm('/oauth/token', {
    client_id: credentials.clientId, token: credentials[kind], token_type_hint: kind,
  });

  let requestId = 0;
  async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
    const response = await send(new Request(RESOURCE, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
    }));
    const text = await response.text();
    const data = text.startsWith('event:') || text.startsWith('data:')
      ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean).at(-1)!
      : text;
    const body = JSON.parse(data) as RpcResponse;
    return { response, body };
  }
  async function call(token: string, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const result = await rpc(token, 'tools/call', { name, arguments: args, ...extra });
    const text = result.body.result?.content?.find(item => item.type === 'text')?.text;
    return { ...result, data: text ? JSON.parse(text) as Record<string, unknown> : undefined };
  }
  return { env, kv, repository, upstream, send, postForm, begin, approve, finish, exchange, connect, refresh, revoke, rpc, call,
    drain: () => Promise.all(pending) };
}
