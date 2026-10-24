import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validateLocale, validateRepositoryConfiguration, validateTimeZone } from '../env';

export const SECRET_NAMES = ['GITHUB_CLIENT_SECRET', 'OWNCONTEXT_GITHUB_TOKEN'] as const;
export type SecretName = typeof SECRET_NAMES[number];
export const setupSchema = z.object({
  owner: z.string(), repo: z.string(), login: z.string(), githubId: z.string().regex(/^[1-9]\d*$/),
  accountId: z.string().regex(/^[a-f0-9]{32}$/), worker: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  origin: z.string(), clientId: z.string().regex(/^[a-zA-Z0-9_.-]+$/), timeZone: z.string(), locale: z.enum(['en', 'zh']),
  createRepo: z.boolean(),
}).strict();
export type SetupConfig = z.infer<typeof setupSchema>;
export interface SetupState { config: SetupConfig; deployedFingerprint?: string }
export interface Observation { repoExists: boolean; repoPrivate: boolean; files: string[]; namespaceId?: string; secrets: string[] }
export type SetupStep = 'create-repo' | 'seed-template' | 'create-kv' | 'write-config' | 'put-secrets' | 'deploy';

export function validateSetup(value: unknown): SetupConfig {
  const config = setupSchema.parse(value);
  validateRepositoryConfiguration('validation-only', config.owner, config.repo);
  validateRepositoryConfiguration('validation-only', config.login, config.repo);
  if (!Number.isSafeInteger(Number(config.githubId))) throw new Error('GitHub ID must be a safe integer.');
  validateTimeZone(config.timeZone); validateLocale(config.locale);
  config.origin = safeOrigin(config.origin);
  return config;
}

export function safeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Use an HTTPS deployment origin, without a path, credentials, query or fragment.');
  return url.origin;
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function deploymentFingerprint(config: SetupConfig, source: string): string {
  return fingerprint([config, source]);
}

export function configDiff(previous: Record<string, unknown>, next: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort()
    .filter(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
}

export function workerConfig(config: SetupConfig, namespaceId: string, buildId: string) {
  return { name: config.worker, account_id: config.accountId, main: '../src/index.ts',
    compatibility_date: '2026-10-12', compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
    workers_dev: true, observability: { enabled: false },
    vars: { GITHUB_OWNER: config.owner, GITHUB_REPO: config.repo, ALLOWED_GITHUB_LOGIN: config.login,
      ALLOWED_GITHUB_ID: config.githubId, GITHUB_CLIENT_ID: config.clientId, TIMEZONE: config.timeZone,
      LOCALE: config.locale, ENABLED_TOOLS: '', BUILD_ID: buildId },
    kv_namespaces: [{ binding: 'OAUTH_KV', id: namespaceId }] };
}

export function buildPlan(config: SetupConfig, observed: Observation, templatePaths: string[], currentConfig: Record<string, unknown>,
  desiredConfig: Record<string, unknown>, deployedFingerprint: string | undefined, desiredFingerprint: string, suppliedSecrets: string[] = []): SetupStep[] {
  if (observed.repoExists && !observed.repoPrivate) throw new Error('Repository must be private. Select a private repository; setup will not change visibility.');
  if (!observed.repoExists && !config.createRepo) throw new Error('Repository not found. Check access or explicitly choose create during setup.');
  const steps: SetupStep[] = [];
  if (!observed.repoExists) steps.push('create-repo');
  if (templatePaths.some(path => !observed.files.includes(path))) steps.push('seed-template');
  if (!observed.namespaceId) steps.push('create-kv');
  if (configDiff(currentConfig, desiredConfig).length) steps.push('write-config');
  if (SECRET_NAMES.some(name => !observed.secrets.includes(name) || suppliedSecrets.includes(name))) steps.push('put-secrets');
  if (steps.includes('write-config') || steps.includes('put-secrets') || deployedFingerprint !== desiredFingerprint) steps.push('deploy');
  return steps;
}

export function clientSnippets(origin: string): string[] {
  const endpoint = `${safeOrigin(origin)}/mcp`;
  return [`Claude Code: claude mcp add --transport http owncontext ${endpoint}`,
    `claude.ai: Settings → Connectors → Add custom connector → URL: ${endpoint}`,
    'Sign in with the configured GitHub account. Access is read-only unless you separately select write permission on the consent page.'];
}
