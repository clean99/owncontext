import { validateTimeZone } from './env';
import { KnowledgeError } from './github';

export function zonedTime(date = new Date(), timeZone = 'UTC'): string {
  if (!Number.isFinite(date.getTime())) throw new KnowledgeError(400, 'invalid_time');
  validateTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (name: string) => parts.find(part => part.type === name)!.value;
  const local = `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
  const offset = Math.round((Date.parse(`${local}Z`) - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const absolute = Math.abs(offset);
  const zone = `${offset < 0 ? '-' : '+'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
  return `${local}.${String(date.getUTCMilliseconds()).padStart(3, '0')}${zone}`;
}

export function parseTime(value?: string, timeZone = 'UTC'): string {
  if (!value) return zonedTime(new Date(), timeZone);
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)? ?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) throw new KnowledgeError(400, 'time_requires_offset');
  const [, day, hour, minute, second = '00', fraction = '', offset] = match;
  if (!validDay(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)
    throw new KnowledgeError(400, 'invalid_time');
  return zonedTime(new Date(`${day}T${hour}:${minute}:${second}${fraction}${offset}`), timeZone);
}

export function occurrenceTime(value: string, timeZone = 'UTC'): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (!validDay(value)) throw new KnowledgeError(400, 'invalid_time');
    return value;
  }
  return parseTime(value, timeZone);
}

export function validDay(value: string): boolean {
  const date = new Date(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
