import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError, isAllowedIdentity, loadConfig, type Env } from '../src/env';
import { GitHubRepository } from '../src/github';
import { handleAuthorization } from '../src/auth';
import { fixtureEnv } from './support/env';
import { RepositoryFixture } from './support/repository';

const requiredFields = ['GITHUB_OWNER', 'GITHUB_REPO', 'ALLOWED_GITHUB_LOGIN', 'ALLOWED_GITHUB_ID',
  'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'OWNCONTEXT_GITHUB_TOKEN', 'OAUTH_KV'] as const;

describe('configuration', () => {
  it.each(requiredFields)('rejects missing %s without printing values', field => {
    expect(() => loadConfig(fixtureEnv({ [field]: undefined }))).toThrow(field);
  });

  it.each<[keyof Env, string]>([
    ['GITHUB_OWNER', '../outside'], ['GITHUB_OWNER', '-invalid'], ['GITHUB_OWNER', 'invalid--login'],
    ['GITHUB_REPO', '../outside'], ['GITHUB_REPO', 'https://example.invalid/notes'], ['GITHUB_REPO', '..'],
    ['ALLOWED_GITHUB_LOGIN', ''], ['ALLOWED_GITHUB_LOGIN', 'other/user'], ['ALLOWED_GITHUB_ID', '0'],
    ['ALLOWED_GITHUB_ID', '-2'], ['ALLOWED_GITHUB_ID', '01'], ['ALLOWED_GITHUB_ID', '1e3'],
    ['ALLOWED_GITHUB_ID', '9007199254740992'], ['OWNCONTEXT_GITHUB_TOKEN', '  '],
    ['OWNCONTEXT_GITHUB_TOKEN', 'fixture\nsecret'], ['GITHUB_CLIENT_ID', ' '], ['GITHUB_CLIENT_SECRET', '\r'],
    ['TIMEZONE', 'Not/AZone'], ['TIMEZONE', ''], ['TIMEZONE', '+08:00'], ['LOCALE', 'xx'],
    ['ENABLED_TOOLS', 'capture'], ['ENABLED_TOOLS', 'log_meal,'], ['COMMITTER_EMAIL', 'bad-address'],
  ])('rejects invalid %s', (field, value) => {
    expect(() => loadConfig(fixtureEnv({ [field]: value }))).toThrow(ConfigurationError);
  });

  it('defaults to UTC, English, no optional tools and the token owner as committer', () => {
    expect(loadConfig(fixtureEnv())).toMatchObject({ timeZone: 'UTC', locale: 'en',
      repository: { enabledTools: [], committer: undefined } });
  });

  it('validates optional configuration without exposing secrets', () => {
    const configured = loadConfig(fixtureEnv({ TIMEZONE: 'America/New_York', LOCALE: 'zh',
      ENABLED_TOOLS: 'capture_conversation, log_meal,log_meal',
      COMMITTER_NAME: 'Sample Writer', COMMITTER_EMAIL: 'writer@example.invalid' }));
    expect(configured.repository.enabledTools).toEqual(['capture_conversation', 'log_meal']);
    expect(configured.repository.committer).toEqual({ name: 'Sample Writer', email: 'writer@example.invalid' });
    expect(configured.timeZone).toBe('America/New_York');
    expect(configured.locale).toBe('zh');
    expect(() => loadConfig(fixtureEnv({ COMMITTER_NAME: 'Sample Writer' }))).toThrow('COMMITTER_EMAIL');
    expect(() => loadConfig(fixtureEnv({ COMMITTER_EMAIL: 'writer@example.invalid' }))).toThrow('COMMITTER_NAME');
    expect(() => loadConfig(fixtureEnv({ COMMITTER_NAME: 'Sample Writer', COMMITTER_EMAIL: 'invalid' }))).toThrow('COMMITTER_EMAIL');
    try { loadConfig(fixtureEnv({ OWNCONTEXT_GITHUB_TOKEN: 'sensitive-value\n' })); }
    catch (error) { expect(String(error)).not.toContain('sensitive-value'); }
  });

  it.each([
    { login: 'sample-user', id: '12345678', repo: 'sample-notes' },
    { login: 'second-user', id: '87654321', repo: 'second-notes' },
  ])('accepts the explicit single-user identity for $login', ({ login, id, repo }) => {
    const env = fixtureEnv({ GITHUB_OWNER: login, GITHUB_REPO: repo, ALLOWED_GITHUB_LOGIN: login, ALLOWED_GITHUB_ID: id });
    expect(loadConfig(env)).toMatchObject({ login, id });
    expect(isAllowedIdentity({ githubLogin: login.toUpperCase(), githubId: id }, env)).toBe(true);
    expect(isAllowedIdentity({ githubLogin: login, githubId: '99999999' }, env)).toBe(false);
    expect(isAllowedIdentity({ githubLogin: 'intruder', githubId: id }, env)).toBe(false);
    expect(isAllowedIdentity({ githubLogin: login, githubId: id }, { ...env, ALLOWED_GITHUB_ID: '' })).toBe(false);
  });

  it('returns a clear configuration error before any OAuth request', async () => {
    const response = await handleAuthorization(new Request('https://owncontext.example/authorize'),
      fixtureEnv({ GITHUB_REPO: '' }));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('GITHUB_REPO is required');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('configured repository boundaries', () => {
  it.each([['sample-user', 'sample-notes'], ['second-user', 'second-notes']])('uses only %s/%s', async (owner, repo) => {
    const fixture = new RepositoryFixture(owner, repo);
    fixture.seedContext();
    await fixture.service().getContext();
    await fixture.service().remember({ path: 'topics/example.md', fact: 'A synthetic fact', source: 'stated' });
    expect(fixture.requests.length).toBeGreaterThan(0);
    expect(fixture.requests.every(request => request.url.startsWith(`https://api.github.com/repos/${owner}/${repo}`))).toBe(true);
    const body = JSON.parse(String(fixture.requests.find(request => request.init?.method === 'PUT')!.init!.body));
    expect(body).not.toHaveProperty('committer');
    expect(body.branch).toBe('main');
  });

  it('uses a configured committer instead of a built-in identity', async () => {
    const fixture = new RepositoryFixture();
    const repository = new GitHubRepository('fixture-token', fixture.owner, fixture.repo, fixture.fetch,
      { committer: { name: 'Sample Writer', email: 'writer@example.invalid' } });
    await repository.put('topics/example.md', 'Synthetic', undefined, 'note: example');
    const body = JSON.parse(String(fixture.requests.at(-1)!.init!.body));
    expect(body.committer).toEqual({ name: 'Sample Writer', email: 'writer@example.invalid' });
  });

  it('rejects invalid repository configuration before networking', () => {
    const fetcher = vi.fn();
    expect(() => new GitHubRepository('', 'sample-user', 'sample-notes', fetcher)).toThrow('OWNCONTEXT_GITHUB_TOKEN');
    expect(() => new GitHubRepository('fixture', 'sample-user', '../other', fetcher)).toThrow('GITHUB_REPO');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
