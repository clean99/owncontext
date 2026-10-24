import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

let runtime: Miniflare;

beforeAll(async () => {
  const bundled = await build({
    stdin: {
      resolveDir: process.cwd(), loader: 'ts',
      contents: `
        import { handleAuthorization } from './src/auth';
        import { GitHubRepository } from './src/github';
        export default {
          async fetch(incoming) {
            const calls = [];
            const rejectRedirect = new URL(incoming.url).pathname === '/redirect';
            globalThis.fetch = async function (input, init) {
              if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
              const request = new Request(input, init);
              calls.push(request.url);
              if (request.redirect !== 'manual') throw new Error('Unexpected redirect policy');
              if (rejectRedirect) return new Response(null, {status:302, headers:{Location:'https://attacker.example/'}});
              if (request.url.endsWith('/access_token')) return Response.json({access_token:'fixture-token',token_type:'bearer',scope:''});
              if (request.url.endsWith('/user')) return Response.json({id:12345678,login:'sample-user'});
              if (request.url.includes('/git/trees/')) return Response.json({sha:'fixture',truncated:false,tree:[]});
              return Response.json({private:true,default_branch:'main'});
            };
            if (new URL(incoming.url).pathname === '/repository') {
              const repository = new GitHubRepository('fixture-repository-token', 'sample-user', 'sample-notes');
              return Response.json({tree:await repository.tree(),calls});
            }
            const env = {
              GITHUB_CLIENT_ID:'fixture-client',GITHUB_CLIENT_SECRET:'fixture-secret',
              ALLOWED_GITHUB_LOGIN:'sample-user',ALLOWED_GITHUB_ID:'12345678',
              OWNCONTEXT_GITHUB_TOKEN:'fixture-token',GITHUB_OWNER:'sample-user',GITHUB_REPO:'sample-notes',
              OAUTH_KV:{get(){},put(){},delete(){},list(){}},
              OAUTH_PROVIDER:{
                async finishUpstream() { return {request:{scope:['owncontext:read']},headers:new Headers(),data:{verifier:'fixture-verifier',redirectUri:'https://owncontext.example/callback'}}; },
                async completeAuthorization() { return {redirectTo:'https://client.example/callback'}; }
              }
            };
            return handleAuthorization(new Request('https://owncontext.example/callback?code=fixture-code'),env);
          }
        };
      `,
    },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    external: ['cloudflare:workers', 'node:*'],
  });
  runtime = new Miniflare({ workers: [{ config: {
    name: 'runtime-test', compatibilityDate: '2026-10-12',
    compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    manifest: { mainModule: 'index.js', modules: {
      'index.js': { type: 'esm', contents: bundled.outputFiles[0].text },
    } },
  } }] });
}, 20_000);

afterAll(async () => { await runtime?.dispose(); });

describe('Worker runtime request compatibility', () => {
  it('constructs both GitHub OAuth requests using the Worker Request implementation', async () => {
    const response = await runtime.dispatchFetch('http://localhost/auth', { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://client.example/callback');
  });

  it('constructs repository requests using the Worker Request implementation', async () => {
    const response = await runtime.dispatchFetch('http://localhost/repository');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tree: { tree: [] }, calls: [
      'https://api.github.com/repos/sample-user/sample-notes',
      'https://api.github.com/repos/sample-user/sample-notes/git/trees/main?recursive=1',
    ] });
  });

  it('refuses an upstream redirect without following it or issuing a grant', async () => {
    const response = await runtime.dispatchFetch('http://localhost/redirect');
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('token_http_302');
    expect(response.headers.get('Location')).toBeNull();
  });
});
