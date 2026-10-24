import { bytes, GitHubRepository, KnowledgeError } from '../github';
import { digest } from '../notes';
import { parseTime } from '../time';

export async function captureConversation(repo: GitHubRepository, timeZone: string, input: { source: string; conversation_id: string; batch_id: string; captured_at: string;
  messages: { id?: string; role: 'user' | 'assistant'; text: string; timestamp?: string }[] }) {
  const time = parseTime(input.captured_at, timeZone);
  const conversationKey = await digest(`${input.source}:${input.conversation_id}`);
  const batchKey = await digest(input.batch_id);
  const filename = `${input.source}-${conversationKey.slice(0, 20)}-${batchKey.slice(0, 20)}.jsonl`;
  const path = `raw/conversations/${time.slice(0, 7)}/${filename}`;
  const rows = [];
  for (let index = 0; index < input.messages.length; index++) {
    const message = input.messages[index];
    const timestamp = message.timestamp ? parseTime(message.timestamp, timeZone) : undefined;
    rows.push({ type: 'message', message_key: await digest(JSON.stringify([conversationKey, message.id ?? index, message.role, message.text])),
      role: message.role, text: message.text, redacted: false, redaction_types: [],
      id: message.id, timestamp, sequence: index + 1, part_index: 0, part_count: 1 });
  }
  const payload = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const payloadHash = await digest(payload);
  const meta = { type: 'meta', schema_version: 1, source: input.source, conversation_id: input.conversation_id,
    conversation_key: conversationKey, captured_at: time, coverage: 'partial', capture_scope: 'available_visible_messages',
    representation: 'source_text', redaction: 'none', payload_hash: payloadHash };
  const content = JSON.stringify(meta) + '\n' + payload;
  if (bytes(content) > 180_000) throw new KnowledgeError(413, 'split_capture_into_smaller_batches');
  return repo.mutate(path, 'capture: conversation', current => {
    if (!current) return content;
    let previous: Record<string, unknown>;
    try { previous = JSON.parse(current.split('\n')[0]); } catch { throw new KnowledgeError(409, 'capture_already_exists'); }
    if (previous.payload_hash !== payloadHash) throw new KnowledgeError(409, 'batch_id_reused');
    return current;
  });
}
