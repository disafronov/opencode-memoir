export { SECRET_PATTERN } from './utils.js';

/** Whether secret sanitization is enabled. Default on. Set MEMOIR_SANITIZE_SECRETS=0 to disable. */
export function isSecretSanitizationEnabled(): boolean {
  return process.env.MEMOIR_SANITIZE_SECRETS !== '0';
}

/**
 * Sessions waiting for a recall instruction (one-shot, consumed by
 * experimental.chat.system.transform on the next LLM call).
 */
export const pendingRecall = new Set<string>();

/** Short acknowledgements that never trigger recall. */
const ACK_PATTERN = /^(ok|thanks|thank you|sounds good|got it|👍|🙏|perfect|great|cool|nice|awesome|understood|makes sense|agree|right|sure|yes|no|done|nvm|never mind|lgtm|looks good|proceed|continue|good|fine)\b/i;

/** Explicit memoir commands always trigger recall regardless of length. */
const EXPLICIT_RECALL_PATTERN = /\b(memoir:recall|memoir:remember|memoir-recall|memoir-remember)\b|(\/recall|\/remember)\b/i;

/** Positive-list patterns — identical to the Claude Code UserPromptSubmit gate. */
const RECALL_TRIGGER_PATTERNS = [
  // Action verbs and domain nouns
  /\b(add|build|implement|refactor|redesign|design|create|write|set( |-)up|wire( |-)up|integrate|migrate|rewrite|extract|extend|plumb|hook( |-)up|ship|scaffold|optimize|fix|debug|review|architect|model|schema|API|service|feature|module|system|pipeline|workflow|make|move|replace|convert|swap|remove|clean( |-)up|transform|investigate|explore|figure( |-)out|plan|decide|choose|pick|compare|walk( |-)?me( |-)?through|take( |-)?a( |-)?stab|help( |-)?me|harness|hook|prompt|test)\b/i,
  // Question starts (how/why/what/where/when/should/can/could/would/is it/are we/do I/does it)
  /^(how|why|what|where|when|should|can|could|would|is it|are we|do I|does it)\b.*\?/im,
  // Code blocks (triple backticks)
  /```/,
  // Code definitions
  /\b(def|function|class|import|export)\s+/,
  // Memoir/recall keywords
  /\b(memoir|recall|remember|memory)\b/i,
  // File extensions
  /\b\w+\.(py|js|ts|tsx|scala|java|go|rs|rb|md|json|yaml|yml|toml|sh|bash|css|html|kt|swift|c|cpp|h|hpp)\b/i,
  // File paths (slash-containing tokens)
  /\w+\/\w+/,
];

export function isAcknowledgement(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  const words = trimmed.split(/\s+/);
  return words.length <= 5 && ACK_PATTERN.test(trimmed);
}

/**
 * Decide whether a user message should trigger a recall instruction.
 * Identical gate logic to the Claude Code UserPromptSubmit hook:
 *
 *  1. Empty text → skip
 *  2. Explicit `/recall` / `memoir:recall` commands → always fire
 *  3. < 10 chars → skip (empty or noise)
 *  4. Acknowledgements (ok/thanks/…) → skip
 *  5. < 40 chars without explicit command → skip (too short for intent)
 *  6. ≥ 40 chars + any trigger pattern → fire
 */
export function shouldTriggerRecall(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Explicit memoir commands fire regardless of length
  if (EXPLICIT_RECALL_PATTERN.test(trimmed)) return true;
  if (trimmed.length < 10) return false;
  if (isAcknowledgement(trimmed)) return false;
  // Gate: ≥ 40 chars + any trigger
  if (trimmed.length >= 40 && RECALL_TRIGGER_PATTERNS.some(p => p.test(trimmed))) return true;
  return false;
}

export const DEFAULT_RECALL_NAMESPACES = ['default', 'project:onboard', 'codebase:onboard'];
