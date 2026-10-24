import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER?: OAuthHelpers;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  OWNCONTEXT_GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  ALLOWED_GITHUB_LOGIN: string;
  ALLOWED_GITHUB_ID: string;
  BUILD_ID?: string;
  TIMEZONE?: string;
  LOCALE?: string;
  ENABLED_TOOLS?: string;
  COMMITTER_NAME?: string;
  COMMITTER_EMAIL?: string;
}

export interface AuthProps {
  githubId: string;
  githubLogin: string;
}

export const READ_SCOPE = 'owncontext:read';
export const WRITE_SCOPE = 'owncontext:write';
export const READ_ONLY_SCOPES = [READ_SCOPE, 'offline_access'];
export const AUTH_SCOPES = [READ_SCOPE, WRITE_SCOPE, 'offline_access'];
export const OPTIONAL_TOOLS = ['capture_conversation', 'log_meal', 'log_decision'] as const;
export type OptionalTool = typeof OPTIONAL_TOOLS[number];
export type Locale = 'en' | 'zh';
export interface RepositoryOptions {
  enabledTools?: readonly OptionalTool[];
  committer?: { name: string; email: string };
}

export class ConfigurationError extends Error {
  constructor(field: string, requirement: string) {
    super(`Invalid configuration: ${field} ${requirement}.`);
  }
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ConfigurationError(field, 'is required');
  if (value !== value.trim() || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new ConfigurationError(field, 'must not contain surrounding whitespace or control characters');
  return value;
}

function githubLogin(value: unknown, field: string): string {
  const login = required(value, field);
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login) || login.includes('--'))
    throw new ConfigurationError(field, 'must be a valid GitHub login');
  return login;
}

function githubId(value: unknown): string {
  const id = required(value, 'ALLOWED_GITHUB_ID');
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
    throw new ConfigurationError('ALLOWED_GITHUB_ID', 'must be a positive safe integer');
  return id;
}

export function validateTimeZone(value: string): string {
  try {
    if (!value || value !== value.trim() || /^[+-]/.test(value)) throw new Error();
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
  } catch { throw new ConfigurationError('TIMEZONE', 'must be an IANA time zone'); }
  return value;
}

export function validateLocale(value: string): Locale {
  if (value !== 'en' && value !== 'zh') throw new ConfigurationError('LOCALE', 'must be en or zh');
  return value;
}

export function validateRepositoryConfiguration(token: string, owner: string, repo: string, options: RepositoryOptions = {}): void {
  required(token, 'OWNCONTEXT_GITHUB_TOKEN');
  githubLogin(owner, 'GITHUB_OWNER');
  required(repo, 'GITHUB_REPO');
  if (!/^[a-z\d_.-]{1,100}$/i.test(repo) || /^\.+$/.test(repo))
    throw new ConfigurationError('GITHUB_REPO', 'must be a repository name, not a URL or path');
  if (options.enabledTools?.some(tool => !OPTIONAL_TOOLS.includes(tool)))
    throw new ConfigurationError('ENABLED_TOOLS', `must contain only ${OPTIONAL_TOOLS.join(', ')}`);
  if (options.committer) {
    required(options.committer.name, 'COMMITTER_NAME');
    const email = required(options.committer.email, 'COMMITTER_EMAIL');
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
      throw new ConfigurationError('COMMITTER_EMAIL', 'must be an email address');
  }
}

export function loadConfig(env: Env) {
  const login = githubLogin(env.ALLOWED_GITHUB_LOGIN, 'ALLOWED_GITHUB_LOGIN');
  const id = githubId(env.ALLOWED_GITHUB_ID);
  required(env.GITHUB_CLIENT_ID, 'GITHUB_CLIENT_ID');
  required(env.GITHUB_CLIENT_SECRET, 'GITHUB_CLIENT_SECRET');
  if (!env.OAUTH_KV || ['get', 'put', 'delete', 'list'].some(method => typeof (env.OAUTH_KV as unknown as Record<string, unknown>)[method] !== 'function'))
    throw new ConfigurationError('OAUTH_KV', 'must be bound to a KV namespace');
  const tools = env.ENABLED_TOOLS === undefined || env.ENABLED_TOOLS.trim() === ''
    ? [] : env.ENABLED_TOOLS.split(',').map(tool => tool.trim());
  if (tools.some(tool => !OPTIONAL_TOOLS.includes(tool as OptionalTool)))
    throw new ConfigurationError('ENABLED_TOOLS', `must contain only ${OPTIONAL_TOOLS.join(', ')}`);
  const committer = env.COMMITTER_NAME !== undefined || env.COMMITTER_EMAIL !== undefined
    ? { name: required(env.COMMITTER_NAME, 'COMMITTER_NAME'), email: required(env.COMMITTER_EMAIL, 'COMMITTER_EMAIL') } : undefined;
  const repository: RepositoryOptions = { enabledTools: [...new Set(tools)] as OptionalTool[], committer };
  validateRepositoryConfiguration(env.OWNCONTEXT_GITHUB_TOKEN, env.GITHUB_OWNER, env.GITHUB_REPO, repository);
  return { login, id, repository, timeZone: validateTimeZone(env.TIMEZONE ?? 'UTC'), locale: validateLocale(env.LOCALE ?? 'en') };
}

export function isAllowedIdentity(value: unknown, env: Env): value is AuthProps {
  if (typeof value !== 'object' || value === null) return false;
  try {
    const login = githubLogin(env.ALLOWED_GITHUB_LOGIN, 'ALLOWED_GITHUB_LOGIN');
    const id = githubId(env.ALLOWED_GITHUB_ID);
    const identity = value as Partial<AuthProps>;
    return typeof identity.githubLogin === 'string' && identity.githubLogin.toLowerCase() === login.toLowerCase()
      && identity.githubId === id;
  } catch { return false; }
}
