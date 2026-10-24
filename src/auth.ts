import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type ConsentDescription,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import { AUTH_SCOPES, READ_ONLY_SCOPES, WRITE_SCOPE, ConfigurationError, isAllowedIdentity, loadConfig, type AuthProps, type Env } from './env';

const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

interface UpstreamState {
  verifier: string;
  redirectUri: string;
}

class UpstreamError extends Error {}

export async function limitRequestBody(request: Request, maxBytes: number): Promise<Request | Response> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return localError('Request body is too large.', 413);
      }
      chunks.push(chunk.value);
    }
  } catch {
    return localError('Request body could not be read.', 400);
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function consentPage(details: ConsentDescription, handle: string, env: Env): string {
  const config = loadConfig(env);
  const name = escapeHtml(details.clientName);
  const publisher = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This client registered itself; its name is not verified.';
  const localWarning = details.redirectIsLoopback
    ? '<p><strong>This grants access to an application on your computer.</strong> Continue only if you started this sign-in.</p>'
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect OwnContext</title></head>
<body><main><h1>Connect ${name} to OwnContext?</h1>
<p>${publisher} Access will be returned to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${localWarning}
<p><strong>Read-only by default.</strong> This client can read your personal knowledge in your private repository, and keep its connection while you use it.</p>
<p>Permissions: ${READ_ONLY_SCOPES.map(escapeHtml).join(', ')}. Only the owner's configured GitHub account can connect. GitHub sign-in requests no repository permissions.</p>
<p>Writing is separate and optional. To enable writes later, reconnect and explicitly grant ${WRITE_SCOPE}. Without it, all write tools are blocked by the server.</p>
<p>Optional tools enabled: ${escapeHtml(config.repository.enabledTools?.join(', ') || 'none')}. Save only information you choose; stored text remains in your private Git history.</p>
<form action="/authorize" method="post"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<p><label><input type="checkbox" name="grant_write" value="yes">Also grant ${WRITE_SCOPE}: allow this client to add and correct notes and use enabled capture or logging tools. Saved content remains in Git history.</label></p>
<button type="submit" name="decision" value="approve">Confirm selected permissions and sign in with GitHub</button>
<button type="submit" name="decision" value="deny">Deny</button></form></main></body></html>`;
}

function localError(message: string, status: number, headers?: Headers): Response {
  const resultHeaders = new Headers(headers);
  resultHeaders.set('Content-Type', 'text/plain; charset=utf-8');
  resultHeaders.set('Cache-Control', 'no-store');
  resultHeaders.set('X-Content-Type-Options', 'nosniff');
  resultHeaders.set('Referrer-Policy', 'no-referrer');
  return new Response(message, { status, headers: resultHeaders });
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function startUpstream(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== new URL(request.url).origin) {
    return localError('Authorization form must be submitted from this server.', 400);
  }
  const form = await request.formData();
  const handle = form.get('handle');
  const decision = form.get('decision');
  if (typeof handle !== 'string' || !handle || !['approve', 'deny'].includes(String(decision))) {
    return localError('Invalid authorization form. Start the connection again.', 400);
  }
  if (decision === 'deny') {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const scope = form.get('grant_write') === 'yes' ? AUTH_SCOPES : READ_ONLY_SCOPES;
  const approved = await oauth.approveConsent(request, handle, { scope });
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const redirectUri = new URL('/callback', request.url).href;
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { verifier, redirectUri },
    headers: approved.headers,
  });
  const url = new URL(GITHUB_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: '',
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
  }).toString();
  headers.set('Location', url.href);
  return new Response(null, { status: 302, headers });
}

async function githubJson(url: string, init: RequestInit, stage: 'token' | 'identity'): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    const timedOut = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
    throw new UpstreamError(`GitHub sign-in failed (${stage}_${timedOut ? 'timeout' : 'network'}). Start the connection again.`);
  }
  if (!response.ok) throw new UpstreamError(`GitHub sign-in failed (${stage}_http_${response.status}).`);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new UpstreamError(`GitHub sign-in failed (${stage}_invalid_json).`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpstreamError(`GitHub sign-in failed (${stage}_invalid_response).`);
  }
  return value as Record<string, unknown>;
}

async function githubIdentity(code: string, state: UpstreamState, env: Env): Promise<AuthProps> {
  const token = await githubJson(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'owncontext' },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      code_verifier: state.verifier,
      redirect_uri: state.redirectUri,
    }),
  }, 'token');
  if (typeof token.access_token !== 'string' || token.token_type !== 'bearer') {
    throw new UpstreamError('GitHub did not issue a sign-in token.');
  }
  if (typeof token.scope !== 'string' || token.scope.trim()) {
    throw new UpstreamError('This GitHub app has extra permissions. Revoke its existing grant and reconnect with identity-only access.');
  }
  const user = await githubJson(GITHUB_USER_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token.access_token}`,
      'User-Agent': 'owncontext',
      'X-GitHub-Api-Version': '2026-03-10',
    },
  }, 'identity');
  if (!Number.isSafeInteger(user.id) || typeof user.login !== 'string') {
    throw new UpstreamError('GitHub returned an invalid identity.');
  }
  return { githubId: String(user.id), githubLogin: user.login };
}

async function finishUpstream(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const resumed = await oauth.finishUpstream<UpstreamState>(request);
  const url = new URL(request.url);
  if (url.searchParams.has('error')) {
    resumed.headers.set('Location', authorizationErrorRedirect(resumed.request, 'access_denied'));
    return new Response(null, { status: 302, headers: resumed.headers });
  }
  const code = url.searchParams.get('code');
  if (!code || !resumed.data?.verifier || !resumed.data.redirectUri) {
    return localError('GitHub sign-in is incomplete. Start the connection again.', 400, resumed.headers);
  }
  let identity: AuthProps;
  try {
    identity = await githubIdentity(code, resumed.data, env);
  } catch (error) {
    const message = error instanceof UpstreamError ? error.message : 'GitHub sign-in is temporarily unavailable.';
    return localError(message, 502, resumed.headers);
  }
  if (!isAllowedIdentity(identity, env)) {
    return localError('This GitHub account is not allowed to connect.', 403, resumed.headers);
  }
  const result = await oauth.completeAuthorization({
    request: resumed.request,
    userId: identity.githubId,
    metadata: { label: 'OwnContext' },
    scope: resumed.request.scope,
    props: identity,
  });
  resumed.headers.set('Location', result.redirectTo);
  return new Response(null, { status: 302, headers: resumed.headers });
}

export async function handleAuthorization(request: Request, env: Env): Promise<Response> {
  try { loadConfig(env); }
  catch (error) {
    return localError(error instanceof ConfigurationError ? error.message : 'Configuration could not be loaded.', 503);
  }
  const path = new URL(request.url).pathname;
  if (path === '/' && request.method === 'GET') {
    return localError('OwnContext MCP. Connect your client to /mcp.', 200);
  }
  if (!['/authorize', '/callback'].includes(path)) return localError('Not found.', 404);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.OAUTH_PROVIDER) {
    return localError('Authorization is not configured.', 503);
  }
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (path === '/callback' && request.method === 'GET') return await finishUpstream(request, env, oauth);
    if (path === '/authorize' && request.method === 'POST') {
      const bounded = await limitRequestBody(request, 16 * 1024);
      return bounded instanceof Response ? bounded : await startUpstream(bounded, env, oauth);
    }
    if (path !== '/authorize' || request.method !== 'GET') return localError('Method not allowed.', 405);
    const authorization = await oauth.parseAuthRequest(request);
    const details = await oauth.describeConsent(authorization);
    const consent = await oauth.beginConsent(authorization);
    consent.headers.set('Content-Type', 'text/html; charset=utf-8');
    consent.headers.set('Referrer-Policy', 'no-referrer');
    consent.headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(consentPage(details, consent.handle, env), { headers: consent.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && path === '/authorize' && request.method === 'GET' && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      return localError('Authorization expired or could not be verified. Start the connection again.', 400);
    }
    return localError('Authorization is temporarily unavailable.', 503);
  }
}
