import { frontmatter } from '../notes';

export interface ToolClient {
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export class ToolFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function markdownDiff(path: string, before: string, after: string): string {
  if (before === after) return '';
  const left = before.trimEnd().split('\n');
  const right = after.trimEnd().split('\n');
  let start = 0;
  while (start < Math.min(left.length, right.length) && left[start] === right[start]) start++;
  let end = 0;
  while (end < Math.min(left.length, right.length) - start && left.at(-1 - end) === right.at(-1 - end)) end++;
  const from = Math.max(0, start - 3);
  const toLeft = Math.min(left.length, left.length - end + 3);
  const toRight = Math.min(right.length, right.length - end + 3);
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -${from + 1},${toLeft - from} +${from + 1},${toRight - from} @@`,
    ...left.slice(from, start).map(line => ` ${line}`),
    ...left.slice(start, left.length - end).map(line => `-${line}`),
    ...right.slice(start, right.length - end).map(line => `+${line}`),
    ...right.slice(right.length - end, toRight).map(line => ` ${line}`)].join('\n');
}

export async function roundTrip(first: ToolClient, second: ToolClient, path: string) {
  const fact = 'For status updates, I prefer bullet lists.';
  const corrected = 'For status updates, I prefer concise paragraphs.';
  const source = '../raw/snippets/preferences.md#m1';
  const correctionSource = '../raw/snippets/preferences.md#m2';
  const input = { path, fact, source: 'stated', source_ref: source, occurred_at: '2026-01-03T09:00:00Z' };
  const saved = await first.call('remember', input);
  const repeated = await first.call('remember', input);
  if (!repeated.unchanged || repeated.sha !== saved.sha) throw new Error('Capture was not idempotent.');
  const read = await second.call('read', { path });
  if (typeof read.text !== 'string' || typeof read.sha !== 'string' || read.sha !== saved.sha
    || !read.text.includes(`[stated] ${fact}`) || !read.text.includes(source)) throw new Error('Second client did not read the saved provenance.');
  const { metadata, body } = frontmatter(read.text);
  const originalLine = body.split('\n').find(line => line.includes(`[stated] ${fact}`))!;
  const next = body.split('\n').map(line => line === originalLine
    ? `- [stated] ${corrected} Source: [selected correction](${correctionSource}), spoken at 2026-01-03T09:05:00Z.` : line).join('\n').trimEnd()
    + `\n\n## Correction history\n\n- Superseded: ${originalLine.replace(/^- /, '')}\n`;
  const update = { path, name: metadata.name, description: metadata.description, expected_sha: read.sha, body: next };
  const correctedWrite = await second.call('update_note', update);
  let conflict = false;
  try { await first.call('update_note', { ...update, body: `${body}\n\nStale client edit.\n` }); }
  catch (error) { if (error instanceof ToolFailure && error.status === 409 && error.code === 'note_changed_read_and_merge') conflict = true; else throw error; }
  if (!conflict) throw new Error('A stale SHA was accepted.');
  const retried = await first.call('remember', input);
  if (!retried.unchanged || retried.sha !== correctedWrite.sha) throw new Error('A capture retry resurrected the superseded preference.');
  const final = await first.call('read', { path });
  if (typeof final.text !== 'string' || final.sha !== correctedWrite.sha || final.sha === read.sha
    || !final.text.includes(corrected) || final.text.includes('Stale client edit.')) throw new Error('Correction did not survive the conflict.');
  return { path, savedSha: read.sha, correctedSha: final.sha, idempotent: true, conflictRejected: conflict,
    markdown: final.text, diff: markdownDiff(path, read.text, final.text) };
}
