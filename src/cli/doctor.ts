import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readJson } from './io';
import { roundTrip, ToolFailure, type ToolClient } from './round-trip';
import { deploymentFingerprint, safeOrigin, validateSetup, type SetupState } from './setup-plan';
import { sourceFingerprint } from './setup';

export interface Diagnostic { code: string; ok: boolean; message: string }
export function diagnoseFailure(error: unknown): Diagnostic {
  if (error instanceof ToolFailure) {
    if (error.code === 'insufficient_scope') return { code: 'wrong-scopes', ok: false,
      message: 'Reconnect using OAuth. Grant read access; acceptance also needs the separate write checkbox on the consent page.' };
    if (error.code === 'github_request_failed' && error.status === 401) return { code: 'repository-unreachable', ok: false,
      message: 'The Worker repository token is invalid or expired. Replace its OWNCONTEXT_GITHUB_TOKEN secret with a token for the private repository (Contents read/write and Metadata read), then run doctor again.' };
    if (error.code === 'mcp_http_error' && error.status === 401) return { code: 'authentication', ok: false, message: 'The MCP access token is missing or expired. Reconnect with the allowed GitHub account and supply a fresh OWNCONTEXT_ACCESS_TOKEN.' };
    if (error.code === 'required_context_missing') return { code: 'missing-template', ok: false, message: 'Required context cards are missing. Resume setup to add missing template files without overwriting existing notes.' };
    if (error.status === 403 || error.status === 404 || error.code === 'github_unavailable') return { code: 'repository-unreachable', ok: false,
      message: 'Check the allowed GitHub identity and private repository owner/name. Replace the repository token if expired; grant only that repository Contents read/write and Metadata read, then resume setup.' };
    if (error.status === 503) return { code: 'missing-config', ok: false, message: 'The Worker configuration is incomplete. Resume setup and check Worker vars, OAuth secrets and the OAUTH_KV binding.' };
  }
  return { code: 'connection', ok: false, message: 'The endpoint or MCP request failed. Check HTTPS origin, DNS, deployment and token expiry, then run doctor again. No credentials or response contents were printed.' };
}

export function diagnoseHealth(status: number, body: unknown, expectedBuild: string): Diagnostic {
  if (status === 503) return diagnoseFailure(new ToolFailure(503, 'configuration'));
  if (status !== 200 || !body || typeof body !== 'object' || !('name' in body) || body.name !== 'owncontext')
    return { code: 'stale-deploy', ok: false, message: 'No OwnContext health endpoint found. Check the origin and deploy the current Worker with setup --resume.' };
  if (!('build_id' in body) || body.build_id !== expectedBuild)
    return { code: 'stale-deploy', ok: false, message: 'The deployed build differs from local source. Run setup --resume to deploy the current build.' };
  return { code: 'deployment', ok: true, message: 'Worker configuration is valid and the deployed build matches local source.' };
}

export interface RemoteClient extends ToolClient { close(): Promise<void> }
export async function connect(origin: string, token: string, request: typeof fetch = fetch): Promise<RemoteClient> {
  const client = new Client({ name: 'owncontext-doctor', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${safeOrigin(origin)}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
    fetch: async (input, init) => {
      const response = await request(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new ToolFailure(response.status,
        response.headers.get('WWW-Authenticate')?.includes('insufficient_scope') ? 'insufficient_scope' : 'mcp_http_error');
      return response;
    }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 100, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 },
  });
  try { await client.connect(transport); } catch (error) { await client.close(); throw error; }
  return {
    async call(name, args) {
      const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 15_000 });
      const text = (response.content as { type: string; text?: string }[]).find(item => item.type === 'text')?.text;
      if (!text) throw new Error('Missing tool result.');
      const value = JSON.parse(text) as Record<string, unknown>;
      if (response.isError) throw new ToolFailure(Number(value.status), String(value.error));
      return value;
    },
    close: () => client.close(),
  };
}

export async function runDoctor(options: { origin?: string; token?: string; expectedBuild: string; acceptance?: boolean },
  dependencies: { request: typeof fetch; connect: typeof connect; runId: () => string }) {
  const diagnostics: Diagnostic[] = [];
  if (!options.origin) return [{ code: 'missing-config', ok: false, message: 'No deployment origin. Run setup or set OWNCONTEXT_URL to your HTTPS Worker origin.' }];
  const origin = safeOrigin(options.origin);
  try {
    const response = await dependencies.request(`${origin}/health`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    let body: unknown;
    try { body = await response.json(); } catch { body = null; }
    diagnostics.push(diagnoseHealth(response.status, body, options.expectedBuild));
  } catch (error) { diagnostics.push(diagnoseFailure(error)); }
  if (diagnostics.some(result => !result.ok)) return diagnostics;
  if (!options.token) return [...diagnostics, { code: 'missing-token', ok: false,
    message: 'Set OWNCONTEXT_ACCESS_TOKEN to an OAuth access token issued by this Worker, not a GitHub token. Repository and scope checks were not run.' }];
  let first: RemoteClient | undefined; let second: RemoteClient | undefined;
  try {
    first = await dependencies.connect(origin, options.token, dependencies.request);
    await first.call('get_context', { mode: 'brief' });
    diagnostics.push({ code: 'repository', ok: true, message: 'Authenticated read and private repository context are reachable. No note contents were printed.' });
    if (options.acceptance) {
      const source = await first.call('read', { path: 'raw/snippets/preferences.md' });
      if (typeof source.text !== 'string' || !source.text.includes('This is synthetic text')
        || !source.text.includes('## m1') || !source.text.includes('## m2')
        || !source.text.includes('I prefer bullet lists.') || !source.text.includes('I prefer concise paragraphs.'))
        throw new Error('Synthetic source template is missing or modified.');
      const id = dependencies.runId();
      if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid acceptance run identifier.');
      const path = `topics/owncontext-acceptance-${id}.md`;
      diagnostics.push({ code: 'acceptance-artifact', ok: true, message: `Synthetic acceptance note: ${path}. Any successful writes remain in private Git history; no files are deleted.` });
      second = await dependencies.connect(origin, options.token, dependencies.request);
      await roundTrip(first, second, path);
      diagnostics.push({ code: 'acceptance', ok: true, message: 'Synthetic save/read/idempotency/correction/stale-SHA rejection passed across two MCP clients.' });
    } else diagnostics.push({ code: 'read-only', ok: true, message: 'No writes performed. Write permission and CAS need the explicit --acceptance check, which creates a synthetic note.' });
  } catch (error) { diagnostics.push(diagnoseFailure(error)); }
  finally { await Promise.allSettled([first?.close(), second?.close()]); }
  return diagnostics;
}

export async function main(root: string, args: string[] = process.argv.slice(2)) {
  if (args.some(arg => !['--acceptance', '--help', '--dry-run'].includes(arg))) throw new Error('Usage: npm run doctor -- [--acceptance] [--dry-run]');
  if (args.includes('--help') || args.includes('--dry-run')) {
    console.log('Doctor checks configuration, build freshness, OAuth read access and repository reachability.');
    console.log('Set OWNCONTEXT_URL (origin) and OWNCONTEXT_ACCESS_TOKEN (Worker OAuth token, never a GitHub token). Without setup state, also set OWNCONTEXT_BUILD_ID to the expected deployment fingerprint.');
    console.log('--acceptance explicitly writes a unique synthetic note and verifies correction and conflict rejection. It requires write consent and leaves Git history intact.');
    console.log('Preview only; no requests or writes performed.'); return;
  }
  const saved = await readJson<SetupState>(join(root, '.owncontext/setup.json'));
  if (saved) validateSetup(saved.config);
  const expectedBuild = saved ? deploymentFingerprint(saved.config, await sourceFingerprint(root)) : process.env.OWNCONTEXT_BUILD_ID;
  if (!saved && process.env.OWNCONTEXT_URL && !expectedBuild) throw new Error('No setup state or expected build ID. Run setup or supply OWNCONTEXT_BUILD_ID for a manually configured deployment.');
  const results = await runDoctor({ origin: process.env.OWNCONTEXT_URL ?? saved?.config.origin,
    token: process.env.OWNCONTEXT_ACCESS_TOKEN, expectedBuild: expectedBuild ?? '', acceptance: args.includes('--acceptance') },
  { request: fetch, connect, runId: randomUUID });
  for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.code}: ${result.message}`);
  if (results.some(result => !result.ok)) process.exitCode = 1;
}
