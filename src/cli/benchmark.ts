import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { MemoryGitHub } from './demo';
import { GitHubRepository } from '../github';
import { KnowledgeService, note, PAGE_SIZE } from '../knowledge';

const WARMUPS = 3;
const SAMPLES = 20;
const metadata = { name: 'Synthetic note', description: 'Local benchmark fixture' };
const body = (id: number) => `- [stated] Synthetic revision ${String(id).padStart(6, '0')}.\n${'Plain Markdown fixture text. '.repeat(32)}`;
const pathFor = (id: number) => `topics/note-${String(id).padStart(6, '0')}.md`;

type Operation = 'read' | 'search_page' | 'search_all' | 'save';

export async function benchmark(fileCount: number, samples = SAMPLES, warmups = WARMUPS) {
  const seed = Object.fromEntries(Array.from({ length: fileCount }, (_, id) => [pathFor(id), note(metadata, body(id), '2026-01-01')]));
  const repository = new MemoryGitHub(seed);
  let requests = 0;
  const fetch: typeof globalThis.fetch = (input, init) => { requests++; return repository.fetch(input, init); };
  const service = () => new KnowledgeService(new GitHubRepository('synthetic-demo', 'sample-user', 'sample-notes', fetch));
  const expectedRequests: Record<Operation, number> = {
    read: 3, save: 4, search_page: 2 + Math.min(PAGE_SIZE, fileCount),
    search_all: fileCount + 2 * Math.ceil(fileCount / PAGE_SIZE),
  };
  const results = [];
  for (const operation of ['read', 'search_page', 'search_all', 'save'] as const) {
    const raw_ms = [];
    const request_counts = [];
    let pages = 0;
    for (let i = -warmups; i < samples; i++) {
      const expectedSha = operation === 'save' ? (await service().read(pathFor(0))).sha : null;
      requests = 0;
      const before = repository.writes;
      const start = performance.now();
      pages = 0;
      if (operation === 'read') {
        const result = await service().read(pathFor(fileCount - 1));
        assert.equal(result.text, seed[pathFor(fileCount - 1)]);
      } else if (operation === 'save') {
        const result = await service().updateNote({ path: pathFor(0), ...metadata,
          body: body(fileCount + i + warmups), expected_sha: expectedSha });
        assert.equal(result.unchanged, false);
        assert.equal(repository.writes, before + 1);
      } else {
        let cursor: string | undefined;
        do {
          const result = await service().search('needle-not-in-fixtures', 'topics/', cursor);
          assert.equal(result.matches.length, 0);
          pages++;
          cursor = result.next_cursor ?? undefined;
        } while (operation === 'search_all' && cursor);
        assert.equal(pages, operation === 'search_all' ? Math.ceil(fileCount / PAGE_SIZE) : 1);
      }
      const elapsed = performance.now() - start;
      assert.equal(requests, expectedRequests[operation]);
      if (i >= 0) { raw_ms.push(Number(elapsed.toFixed(3))); request_counts.push(requests); }
    }
    const sorted = [...raw_ms].sort((a, b) => a - b);
    results.push({ operation, pages, request_counts, raw_ms,
      p50_ms: sorted[Math.ceil(samples * 0.5) - 1], p95_ms: sorted[Math.ceil(samples * 0.95) - 1] });
  }
  return { files: fileCount, initial_bytes_per_file: Buffer.byteLength(seed[pathFor(0)]), results };
}

export async function main() {
  console.log(JSON.stringify({
    measured_at: new Date().toISOString(),
    environment: { node: process.versions.node, platform: process.platform, architecture: process.arch },
    method: {
      command: 'npm run benchmark', warmups_per_operation: WARMUPS, samples_per_operation: SAMPLES,
      unit: 'milliseconds', concurrency: 1,
      layer: 'KnowledgeService and GitHubRepository using the demo MemoryGitHub fetch substitute',
      fixtures: '100 and 1000 unique synthetic Markdown notes; fixed-length bodies; no private data',
      timing: 'performance.now; includes fresh service construction, local API JSON/base64 processing and assertions; excludes fixture creation and CLI bundling',
      cache: 'Fresh service/repository adapter per tool call and per search page; no shared tree/blob cache',
      read: 'Read the final note in the repository tree',
      search_page: 'One 25-file page, absent keyword, zero matches',
      search_all: 'Follow all cursors to exhaust the absent-keyword search, including empty pages',
      save: 'SHA-checked update_note of an existing file; changed fixed-length body; preparatory SHA read excluded',
      percentiles: 'Nearest-rank p50 and p95 of 20 samples; raw samples retained in execution order',
      limitations: 'In-process test-double wall time only. No HTTP transport, OAuth, KV, network latency, real Git commits, rate limits, Worker CPU or deployment measurement. The substitute performs linear blob lookup; these numbers are not production latency or a free-tier guarantee.',
    },
    runs: [await benchmark(100), await benchmark(1000)],
  }, null, 2));
}
