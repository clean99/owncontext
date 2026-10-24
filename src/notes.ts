import { parse, stringify } from 'yaml';
import { KnowledgeError } from './github';
import { validDay } from './time';

export async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export interface Metadata { name: string; description: string; aliases?: string[]; status?: string; review_on?: string }

export function frontmatter(text: string): { metadata: Record<string, unknown>; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new KnowledgeError(422, 'frontmatter_required');
  let value: unknown;
  try { value = parse(match[1], { maxAliasCount: 0, uniqueKeys: true, intAsBigInt: true }); }
  catch { throw new KnowledgeError(422, 'invalid_frontmatter'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KnowledgeError(422, 'invalid_frontmatter');
  return { metadata: value as Record<string, unknown>, body: text.slice(match[0].length) };
}

export function render(metadata: Record<string, unknown>, body: string): string {
  return `---\n${stringify(metadata)}---\n\n${body.trim()}\n`;
}

export function updated(text: string, day: string): string {
  const { metadata, body } = frontmatter(text);
  return render({ ...metadata, updated: day }, body);
}

export function noteMetadata(metadata: Metadata, day: string, previous: Record<string, unknown> = {}): Record<string, unknown> {
  if (!metadata.name.trim() || !metadata.description.trim() || /\r|\n/.test(metadata.description))
    throw new KnowledgeError(400, 'name_and_one_line_description_required');
  if (metadata.review_on && !validDay(metadata.review_on)) throw new KnowledgeError(400, 'invalid_review_date');
  return { ...previous, name: metadata.name, description: metadata.description, aliases: metadata.aliases ?? previous.aliases ?? [],
    updated: day, ...(metadata.status !== undefined ? { status: metadata.status } : {}),
    ...(metadata.review_on !== undefined ? { review_on: metadata.review_on } : {}) };
}

export function note(metadata: Metadata, body: string, day: string): string {
  return render(noteMetadata(metadata, day), body);
}
