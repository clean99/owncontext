import { GitHubRepository, KnowledgeError } from '../github';
import { digest } from '../notes';
import { parseTime } from '../time';

export async function logMeal(repo: GitHubRepository, timeZone: string, input: { time?: string; items: string[]; kcal_est?: number; protein_g_est?: number; notes?: string; request_id?: string }) {
  if (input.request_id && !input.time) throw new KnowledgeError(400, 'stable_request_id_requires_time');
  const time = parseTime(input.time, timeZone);
  const path = `data/meals/${time.slice(0, 7)}.jsonl`;
  const requestId = input.request_id ?? crypto.randomUUID();
  const payload = { items: input.items, kcal_est: input.kcal_est,
    protein_g_est: input.protein_g_est, notes: input.notes,
    supplied_time: input.time ? time : undefined };
  const payloadHash = await digest(JSON.stringify(payload));
  const row = { id: requestId, time, ...payload, payload_hash: payloadHash };
  const result = await repo.mutate(path, 'meal: record', current => {
    for (const line of (current ?? '').split('\n').filter(Boolean)) {
      let record: Record<string, unknown>;
      try { record = JSON.parse(line); } catch { throw new KnowledgeError(422, 'invalid_existing_meal_data'); }
      if (record.id !== requestId) continue;
      if (record.payload_hash !== payloadHash) throw new KnowledgeError(409, 'idempotency_key_reused');
      return current!;
    }
    return `${current?.trimEnd() ? current.trimEnd() + '\n' : ''}${JSON.stringify(row)}\n`;
  });
  return { ...result, request_id: requestId, time };
}
