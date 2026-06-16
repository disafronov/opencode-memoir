import { type Plugin, type PluginModule } from '@opencode-ai/plugin';
import { deriveStorePath, setPluginStoreOverride } from './store.js';
import { memoirTools } from './tools.js';
import { registerCommands, handleCommandExecuteBefore } from './commands.js';
import { handleShellEnv, handleToolExecuteAfter, handleChatMessage, flushAllCapture } from './capture-hooks.js';
import { handleEvent, handleSystemTransform, clearSessionContext } from './session-context.js';

const MemoirOpenCode: Plugin = async (_input, rawOptions) => {
  const opts = (rawOptions ?? {}) as { store?: string };
  if (opts.store) setPluginStoreOverride(opts.store);

  // Resolve store path once at init so shell.env doesn't call execFileSync
  // on every shell command (mirrors Claude Code's MEMOIR_STORE_PATH caching).
  const storeRoot = deriveStorePath();

  return ({
  name: 'memoir',
  tool: { ...memoirTools },
  config: async (opencodeConfig: Record<string, unknown>) => {
    registerCommands(opencodeConfig as Parameters<typeof registerCommands>[0]);
  },
  'command.execute.before': async (input: { command?: string }, output: { parts: unknown[] }) => {
    await handleCommandExecuteBefore(storeRoot, input, output);
  },

  /**
   * Inject MEMOIR_STORE into every shell command's environment so any memoir
   * invocation automatically targets the right store without manual -s flags.
   * Uses the cached value resolved at init time (avoiding execFileSync overhead
   * on every shell command).
   */
  'shell.env': async (_input, output) => {
    await handleShellEnv(storeRoot, _input, output as { env: Record<string, string> });
  },

  /**
   * Observe every tool execution for metrics and code-change tracking.
   * Mirrors the observation phase of Claude Code's Stop hook.
   * Never modifies the tool output.
   */
  'tool.execute.after': async (input, output) => {
    await handleToolExecuteAfter(input, output);
  },

  /**
   * Fires on every incoming user message.
   *
   * 1. Auto-match memoir branch to current git branch
   *    (cf. UserPromptSubmit's auto_match_memoir_branch in Claude Code plugin).
   * 2. Flush pending edits from the previous assistant turn
   *    (cf. Stop hook code change audit, run after each turn).
   * 3. Run the recall gate (cf. UserPromptSubmit).
   *
   * Steps 1–2 are skipped when MEMOIR_NO_CAPTURE=1.
   */
  'chat.message': async (input, output) => {
    await handleChatMessage(storeRoot, input, output);
  },

  /**
   * Fires on SDK events. On session.created, kick off a background fetch of
   * the taxonomy overview so it's ready before the first LLM call.
   * Mirrors Claude Code's SessionStart context injection.
   */
  event: async (input: { event: { type: string } }) => {
    await handleEvent(storeRoot, input);
  },

  /**
   * Fires before every LLM call.
   *
   * 1. Injects the memoir taxonomy context for this session (once per session).
   * 2. If a recall is pending for this session, injects a brief instruction
   *    telling the model to use memoir tools (one-shot per trigger).
   */
  'experimental.chat.system.transform': async (input, output) => {
    await handleSystemTransform(input, output);
  },

  /**
   * Fires when the plugin is shut down. Flushes any remaining code changes
   * and metrics (cf. SessionEnd heartbeat cleanup + final metrics flush).
   */
  dispose: async () => {
    try {
      // No sessionID → flushCapture flushes ALL sessions
      await flushAllCapture(storeRoot);
      clearSessionContext();
    } catch (e: unknown) {
      // Errors are already logged inside flushAllCapture
    }
  },
});
};

/**
 * V1 plugin module format: OpenCode's loader recognizes `{ id, server }` and
 * ignores any other module exports. The legacy format (default-exported
 * function) made the loader treat EVERY export as a plugin and fail on
 * non-function exports ("Plugin export is not a function").
 */
const plugin: PluginModule = {
  id: 'opencode-memoir',
  server: MemoirOpenCode,
};

export default plugin;
