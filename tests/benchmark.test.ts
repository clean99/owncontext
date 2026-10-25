import { describe, expect, it } from 'vitest';
import { benchmark } from '../src/cli/benchmark';

describe('local benchmark workload', () => {
  it('uses fresh adapters, exhausts empty search pages, and performs changed saves', async () => {
    const result = await benchmark(100, 2, 1);
    expect(result.files).toBe(100);
    expect(result.results.map(({ operation, pages, request_counts }) => ({ operation, pages, request_counts }))).toEqual([
      { operation: 'read', pages: 0, request_counts: [3, 3] },
      { operation: 'search_page', pages: 1, request_counts: [27, 27] },
      { operation: 'search_all', pages: 4, request_counts: [108, 108] },
      { operation: 'save', pages: 0, request_counts: [4, 4] },
    ]);
    for (const operation of result.results) {
      expect(operation.raw_ms).toHaveLength(2);
      expect(operation.raw_ms.every(value => Number.isFinite(value) && value >= 0)).toBe(true);
      expect(operation.p95_ms).toBeGreaterThanOrEqual(operation.p50_ms);
    }
  });
});
