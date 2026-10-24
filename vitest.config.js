import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { 'cloudflare:workers': fileURLToPath(new URL('./tests/support/workers.ts', import.meta.url)) },
  },
  test: {
    setupFiles: ['./tests/support/setup.ts'],
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
});
