import type { OptionalTool } from './env';

export const READ_ONLY_FILES = new Set([
  'AGENTS.md', 'CLAUDE.md', 'README.md', 'HANDOVER.md', 'START_HERE.md', 'integrations/owncontext.json',
]);
export const READ_ROOTS = new Set(['me', 'areas', 'people', 'topics', 'decisions', 'data', 'raw', 'summaries', 'docs']);
export const NOTE_ROOTS = new Set(['me', 'areas', 'people', 'topics', 'summaries']);
export const FACT_ROOTS = new Set(['me', 'areas', 'people', 'topics']);
export const PROTECTED_PATHS = new Set(['me/values.md']);
export const RULES_PATH = 'AGENTS.md';
export const CONTEXT_CARDS = [['me/profile.md', 180], ['me/preferences.md', 300], ['me/values.md', 120]] as const;
export const KNOWLEDGE_PATH = /^(me|areas|people|topics|decisions|summaries)\/.+\.md$/;
export const MODULE_WRITE_PATHS: Record<OptionalTool, RegExp> = {
  log_meal: /^data\/meals\/\d{4}-\d{2}\.jsonl$/,
  log_decision: /^decisions\/\d{4}-\d{2}-\d{2}-[^/]+\.md$/,
  capture_conversation: /^raw\/conversations\/\d{4}-\d{2}\/[^/]+\.jsonl$/,
};
