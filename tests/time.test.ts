import { afterEach, describe, expect, it, vi } from 'vitest';
import { occurrenceTime, parseTime, zonedTime } from '../src/time';
import { KnowledgeService } from '../src/knowledge';
import { frontmatter } from '../src/notes';
import { RepositoryFixture } from './support/repository';

afterEach(() => { vi.useRealTimers(); });

describe('configured time zones and locale', () => {
  it.each([
    ['2026-03-08T06:59:00Z', 'America/New_York', '2026-03-08T01:59:00.000-05:00'],
    ['2026-03-08T07:01:00Z', 'America/New_York', '2026-03-08T03:01:00.000-04:00'],
    ['2026-11-01T05:30:00Z', 'America/New_York', '2026-11-01T01:30:00.000-04:00'],
    ['2026-11-01T06:30:00Z', 'America/New_York', '2026-11-01T01:30:00.000-05:00'],
    ['2026-01-01T00:10:00Z', 'America/Los_Angeles', '2025-12-31T16:10:00.000-08:00'],
    ['2026-01-31T20:00:00Z', 'Asia/Kathmandu', '2026-02-01T01:45:00.000+05:45'],
    ['2026-01-03T00:00:00.123Z', 'UTC', '2026-01-03T00:00:00.123+00:00'],
  ])('normalizes %s in %s', (input, zone, expected) => {
    expect(parseTime(input, zone)).toBe(expected);
    expect(Date.parse(expected)).toBe(Date.parse(input));
  });

  it('preserves occurrence dates and defaults timestamps to UTC', () => {
    expect(occurrenceTime('2026-01-03', 'America/Los_Angeles')).toBe('2026-01-03');
    expect(parseTime('2026-01-03T09:00+08:00')).toBe('2026-01-03T01:00:00.000+00:00');
    expect(() => zonedTime(new Date('invalid'))).toThrow('invalid_time');
  });

  it('uses local days for note metadata and local months for events', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-02-01T01:00:00Z'));
    const fixture = new RepositoryFixture();
    const service = fixture.service(undefined, 'America/Los_Angeles');
    const result = await service.remember({ path: 'topics/example.md', fact: 'Synthetic', source: 'stated' });
    expect(frontmatter(fixture.files.get(result.path)!.text).metadata.updated).toBe('2026-01-31');
    const meal = await service.logMeal({ time: '2026-02-01T01:00:00Z', items: ['Synthetic meal'] });
    expect(meal.path).toBe('data/meals/2026-01.jsonl');
    const capture = await service.capture({ source: 'test', conversation_id: 'c', batch_id: 'b', captured_at: '2026-02-01T01:00:00Z',
      messages: [{ role: 'user', text: 'Synthetic' }] });
    expect(capture.path).toMatch(/^raw\/conversations\/2026-01\//);
  });

  it('supports localized note templates without changing tool descriptions or provenance labels', async () => {
    const fixture = new RepositoryFixture();
    const service = new KnowledgeService(fixture.service().repo, { locale: 'zh' });
    const fact = await service.remember({ path: 'topics/example.md', fact: '合成事实', source: 'stated', source_ref: 'synthetic-message' });
    expect(fixture.files.get(fact.path)!.text).toContain('[stated] 合成事实');
    expect(fixture.files.get(fact.path)!.text).toContain('来源: "synthetic-message"');
    const decision = await service.logDecision({ question: '合成问题', data_used: [], ai_analysis: '合成推断', my_decision: '合成选择' });
    expect(fixture.files.get(decision.path)!.text).toContain('## 本人决定');
  });
});
