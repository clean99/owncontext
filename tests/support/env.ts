import type { Env } from '../../src/env';

export class MemoryKv {
  records = new Map<string, string>();
  async get(key: string, options?: string | { type?: string }): Promise<unknown> {
    const value = this.records.get(key);
    if (value === undefined) return null;
    return (typeof options === 'string' ? options : options?.type) === 'json' ? JSON.parse(value) : value;
  }
  async put(key: string, value: string): Promise<void> { this.records.set(key, value); }
  async delete(key: string): Promise<void> { this.records.delete(key); }
  async list(options: { prefix?: string } = {}) {
    return { keys: [...this.records.keys()].filter(name => name.startsWith(options.prefix ?? '')).map(name => ({ name })), list_complete: true, cacheStatus: null };
  }
}

export function fixtureEnv(overrides: Partial<Env> = {}): Env {
  return {
    OAUTH_KV: { get: async () => null, put: async () => {}, delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }) } as unknown as KVNamespace,
    GITHUB_CLIENT_ID: 'fixture-client', GITHUB_CLIENT_SECRET: 'fixture-secret',
    OWNCONTEXT_GITHUB_TOKEN: 'fixture-repository-token',
    GITHUB_OWNER: 'sample-user', GITHUB_REPO: 'sample-notes',
    ALLOWED_GITHUB_LOGIN: 'sample-user', ALLOWED_GITHUB_ID: '12345678',
    ...overrides,
  };
}
