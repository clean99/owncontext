import type { Locale } from '../env';
import { GitHubRepository, KnowledgeError } from '../github';
import { digest, note } from '../notes';
import { validDay, zonedTime } from '../time';

export async function logDecision(repo: GitHubRepository, timeZone: string, locale: Locale, input: { question: string; data_used: string[]; ai_analysis: string; my_decision: string; review_on?: string; request_id?: string; recorded_on?: string }) {
  if (input.request_id && !input.recorded_on) throw new KnowledgeError(400, 'stable_request_id_requires_recorded_on');
  const day = input.recorded_on ?? zonedTime(new Date(), timeZone).slice(0, 10);
  if (!validDay(day)) throw new KnowledgeError(400, 'invalid_recorded_date');
  const id = await digest(input.request_id ?? JSON.stringify([day, input.question, input.my_decision]));
  const title = input.question.replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 32) || 'decision';
  const payloadHash = await digest(JSON.stringify([input.question, input.data_used, input.ai_analysis, input.my_decision, input.review_on]));
  const path = `decisions/${day}-${input.request_id ? 'decision' : title}-${id.slice(0, 24)}.md`;
  const labels = locale === 'zh'
    ? { description: '记录本人已作出的决定、依据与复盘日期。', question: '问题', data: '使用的数据', analysis: '分析', decision: '本人决定' }
    : { description: 'A decision made by the user, its evidence and review date.', question: 'Question', data: 'Data used', analysis: 'Analysis', decision: 'User decision' };
  const content = note({ name: input.question, description: labels.description,
    review_on: input.review_on }, `# ${input.question}\n\n## ${labels.question}\n\n- [stated] ${input.question}\n\n## ${labels.data}\n\n${input.data_used.map(value => `- [stated] ${value}`).join('\n')}\n\n## ${labels.analysis}\n\n- [inferred] ${input.ai_analysis}\n\n## ${labels.decision}\n\n- [stated] ${input.my_decision}\n\n<!-- decision-payload:${payloadHash} -->\n`, day);
  return repo.mutate(path, `decision: ${title}`, current => {
    if (current?.includes(`<!-- decision-payload:${payloadHash} -->`)) return current;
    if (current) throw new KnowledgeError(409, 'decision_id_reused');
    return content;
  });
}
