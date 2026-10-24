import OAuthProvider, { OAuthError, insufficientScope, type OAuthResourceAuth } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { handleAuthorization, limitRequestBody } from './auth';
import { READ_SCOPE, AUTH_SCOPES, ConfigurationError, isAllowedIdentity, loadConfig, type Env } from './env';
import { createServer } from './tools';

export default {
  async fetch(request, env, ctx) {
    try { loadConfig(env); }
    catch (error) {
      return new Response(error instanceof ConfigurationError ? error.message : 'Configuration could not be loaded.',
        { status: 503, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    let providerRequest: Request = request;
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return Response.json({
      name: 'owncontext', version: '0.1.0', build_id: env.BUILD_ID ?? null,
    }, { headers: { 'Cache-Control': 'no-store' } });
    if (request.method === 'POST' && ['/oauth/token', '/oauth/register'].includes(path)) {
      const bounded = await limitRequestBody(request, 64 * 1024);
      if (bounded instanceof Response) return bounded;
      providerRequest = bounded;
    }
    const resource = new URL('/mcp', request.url).href;
    const provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: {
        async fetch(apiRequest, apiEnv, apiContext) {
          if (new URL(apiRequest.url).pathname !== '/mcp') return new Response('Not found.', { status: 404 });
          if (!isAllowedIdentity(apiContext.props, apiEnv)) return new Response('Forbidden.', { status: 403 });
          const auth = (apiContext as typeof apiContext & { auth: OAuthResourceAuth }).auth;
          if (!auth) return new Response('Forbidden.', { status: 403 });
          if (!auth.scope.includes(READ_SCOPE)) return insufficientScope(auth, [READ_SCOPE]);
          const bounded = apiRequest.method === 'POST' ? await limitRequestBody(apiRequest, 1024 * 1024) : apiRequest;
          if (bounded instanceof Response) return bounded;
          return createMcpHandler(() => createServer(apiEnv, auth.scope), { route: '/mcp' })(bounded, apiEnv, apiContext);
        },
      },
      defaultHandler: { fetch: handleAuthorization },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: AUTH_SCOPES,
      requiredScopes: [READ_SCOPE],
      resourceMetadata: { resource, resource_name: 'OwnContext' },
      accessTokenTTL: 3600,
      refreshTokenTTL: 2_592_000,
      refreshTokenIdleTTL: 2_592_000,
      tokenExchangeCallback({ props, env: tokenEnv }) {
        if (!isAllowedIdentity(props, tokenEnv)) {
          throw new OAuthError('invalid_grant', { description: 'Account is not permitted.' });
        }
      },
    });
    return provider.fetch(providerRequest, env, ctx);
  },
} satisfies ExportedHandler<Env>;
