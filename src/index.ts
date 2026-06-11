import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { type Config, type Plugin, type PluginModule, tool } from '@opencode-ai/plugin';
import { autoMatchMemoirBranch, codeGitBranch, deriveStorePath, ensureStore, memoirResolved, memoirSpawnSpecs, runMemoir, setPluginStoreOverride } from './store.js';
import { EDIT_TOOLS, flushCapture, getCachedBranch, recordEdit, recordToolMetrics, setCachedBranch } from './capture.js';
import { DEFAULT_RECALL_NAMESPACES, isSecretSanitizationEnabled, pendingRecall, SECRET_PATTERN, shouldTriggerRecall } from './recall-gate.js';
import { coercePaths, MEMOIR_GET_MAX_KEYS, tryPrettyJson } from './utils.js';
import { debugLog } from './debug.js';

type CommandOutput = {
  parts: unknown[];
};

type OpenCodeConfig = Config & {
  command?: Config['command'];
};

type MemoirRememberArgs = {
  content: string;
  path?: string | string[];
  namespace?: string;
  replace?: boolean;
};

type MemoirRecallArgs = {
  query?: string;
  namespace?: string;
  namespaces?: string[];
  includeMetrics?: boolean;
};

type MemoirGetArgs = {
  keys: string[];
  namespace?: string;
};

async function statusJson(store: string): Promise<string> {
  await ensureStore(store);
  const raw = await runMemoir(['--json', '-s', store, 'status'], { cwd: store });
  try {
    const data = JSON.parse(raw);
    const branch = await codeGitBranch();
    data.opencode = { store, project_git_root: process.cwd(), project_git_branch: branch };
    return JSON.stringify(data, null, 2);
  } catch (e) {
    debugLog('statusJson: failed to parse JSON:', e instanceof Error ? e.message : String(e));
    return raw;
  }
}

async function launchUi(store: string): Promise<string> {
  await ensureStore(store);
  const pidDir = join(homedir(), '.memoir', 'ui-servers');
  await mkdir(pidDir, { recursive: true });
  const hash = createHash('sha256').update(store).digest('hex').slice(0, 8);
  const pidfile = join(pidDir, `${hash}.json`);

  try {
    const existing = JSON.parse(await readFile(pidfile, 'utf8'));
    if (existing?.pid && existing?.url) {
      try {
        process.kill(Number(existing.pid), 0); // check if alive
        return JSON.stringify({ ...existing, reused: true }, null, 2);
      } catch (e) {
        debugLog('launchUi: process dead, relaunching:', e instanceof Error ? e.message : String(e));
        // process is dead — fall through to relaunch
      }
    }
  } catch (e) {
    debugLog('launchUi: failed to read pidfile:', e instanceof Error ? e.message : String(e));
    await rm(pidfile, { force: true }).catch(() => undefined);
  }

  let lastError = '';
  const uiSpecs = memoirSpawnSpecs(['ui', store]);
  // Reorder: put cached memoir resolver first, same as runMemoir
  if (memoirResolved) {
    const idx = uiSpecs.findIndex(s => s.label === memoirResolved);
    if (idx > 0) {
      const [cached] = uiSpecs.splice(idx, 1);
      uiSpecs.unshift(cached);
    }
  }
  for (const spec of uiSpecs) {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let output = '';
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { output += String(chunk); });

    const spawnFailed = new Promise<string | null>(resolve => {
      child.once('error', error => resolve(String(error.message || error)));
      child.once('spawn', () => resolve(null));
    });
    const error = await spawnFailed;
    if (error) {
      lastError = `${spec.label}: ${error}`;
      continue;
    }

    child.unref();

    const urlPattern = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+\S*/;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const match = output.match(urlPattern);
      if (match) {
        const url = match[0];
        const data = { pid: child.pid, url, store, command: spec.label, started: new Date().toISOString(), reused: false };
        await writeFile(pidfile, JSON.stringify(data, null, 2));
        return JSON.stringify(data, null, 2);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return `Memoir UI started with ${spec.label} (pid ${child.pid ?? 'unknown'}), but URL was not detected yet.\n${output.trim()}`.trim();
  }

  return `Memoir UI failed to start: ${lastError || 'no launcher succeeded'}`;
}

function pushText(output: CommandOutput, text: string): void {
  output.parts.length = 0;
  output.parts.push({ type: 'text', text });
}

/** Cached session init context (taxonomy overview). Fetched once, injected per-session. */
let initContext: string | null = null;
let initContextFetched = false;
/**
 * Tracks sessions that have received initial context injection.
 * Uses a Map with timestamp so stale entries can be evicted.
 * Cleaned on dispose. Sessions older than 1 hour are considered stale.
 */
const SESSION_CONTEXT_TTL_MS = 60 * 60 * 1000;
const sessionsWithContext = new Map<string, number>();

/** Check if a session has received context (and prune stale entries opportunistically). */
function hasSessionContext(sessionID: string): boolean {
  const ts = sessionsWithContext.get(sessionID);
  if (ts === undefined) return false;
  if (Date.now() - ts > SESSION_CONTEXT_TTL_MS) {
    sessionsWithContext.delete(sessionID);
    return false;
  }
  return true;
}

/** Mark a session as having received context. */
function markSessionContext(sessionID: string): void {
  sessionsWithContext.set(sessionID, Date.now());
}

/** Prune all stale session entries. */
function pruneStaleSessions(): void {
  const now = Date.now();
  for (const [id, ts] of sessionsWithContext) {
    if (now - ts > SESSION_CONTEXT_TTL_MS) sessionsWithContext.delete(id);
  }
}

function registerCommands(config: OpenCodeConfig): void {
  config.command = config.command ?? {};

  config.command['memoir:status'] = {
    description: 'Show Memoir status for the current OpenCode project',
    template: 'Show Memoir status for this OpenCode project.',
  };

  config.command['memoir:ui'] = {
    description: 'Launch or reopen the Memoir web UI for this project store',
    template: 'Launch or reopen the Memoir UI for this project.',
  };

  config.command['memoir:remember'] = {
    description: 'Save a durable fact, preference, rule, or decision to Memoir',
    template: `Use Memoir to save this durable memory now.\n\nUSER REQUEST:\n$ARGUMENTS\n\nExtract the memory content, choose a semantic path if none is supplied, then call the memoir_remember tool. Never save secrets.`,
  };

  config.command['memoir:recall'] = {
    description: 'Recall relevant facts from Memoir before answering',
    template: `Recall relevant Memoir memories for this request.\n\nUSER REQUEST:\n$ARGUMENTS\n\nUse memoir_recall first. It checks default plus onboard namespaces unless a namespace is specified. Then call memoir_get with the matching namespace for exact values before answering.`,
  };

  config.command['memoir:onboard'] = {
    description: 'Populate or refresh Memoir onboarding for this project',
    template: `Populate or refresh Memoir onboarding for the CURRENT OpenCode project only.\n\nUSER REQUEST:\n$ARGUMENTS\n\nWorkflow:\n- Stay inside the current project/worktree. Do not inspect parent directories.\n- First obtain a project file tree to understand structure.\n- Start studying from project documentation.\n- Continue only based on what the tree and documentation show.\n\nMemory rules:\n- Record only verified facts from files/docs/code or explicit user statements.\n- Do not write inferred user thoughts, intentions, preferences, or opinions.\n- Do not use preferences.* paths unless the user explicitly stated a preference.\n- If a fact is your interpretation, do not save it; report it as uncertain instead.\n\nThen call memoir_remember with replace=true for durable onboarding facts. Use namespace codebase:onboard in git repositories and project:onboard outside git. Do not install or invoke separate skills/scripts.`,
  };

  config.command['memoir:unmerged'] = {
    description: 'List memoir branches with changes not yet merged into main',
    template: 'List memoir branches that have diverged from main.',
  };
}

const memoirStatus = tool({
  description: 'Show Memoir status for the current OpenCode project store.',
  args: {},
  execute: async () => statusJson(deriveStorePath()),
});

const memoirRemember = tool({
  description: 'Explicitly save a durable memory to Memoir at one or more semantic taxonomy paths.',
  args: {
    content: tool.schema.string().describe('Memory content to save. Do not include secrets.'),
    path: tool.schema.string().optional().describe('Semantic taxonomy path, e.g. preferences.coding.style.'),
    namespace: tool.schema.string().optional().describe('Memoir namespace. Defaults to default.'),
    replace: tool.schema.boolean().optional().describe('Replace existing value at the path.'),
  },
  execute: async (args: MemoirRememberArgs) => {
    const content = args.content?.trim();
    if (!content) return 'Memoir memory was not saved: content is empty.';
    if (isSecretSanitizationEnabled() && SECRET_PATTERN.test(content)) {
      return 'Memoir memory was not saved: the content looks like a secret or credential. Save a redacted rule instead.';
    }
    const paths = coercePaths(args.path);
    if (paths.length === 0) {
      return 'Memoir memory was not saved: provide a semantic path, e.g. preferences.coding.style.';
    }

    const store = deriveStorePath();
    try {
      await ensureStore(store);
    } catch (error) {
      return String((error as Error).message || error);
    }

    const cliArgs = ['--json', '-s', store, 'remember', content];
    for (const p of paths) cliArgs.push('-p', p);
    cliArgs.push('-n', args.namespace ?? 'default');
    if (args.replace) cliArgs.push('--replace');
    return tryPrettyJson(await runMemoir(cliArgs, { cwd: store }));
  },
});

const memoirRecall = tool({
  description: 'List Memoir memory keys across relevant namespaces for relevance picking. Never calls legacy memoir recall.',
  args: {
    query: tool.schema.string().optional().describe('User query or topic to recall for.'),
    namespace: tool.schema.string().optional().describe('Single Memoir namespace to inspect. If omitted, checks default + onboard namespaces.'),
    namespaces: tool.schema.array(tool.schema.string()).optional().describe('Namespaces to inspect. Defaults to default, project:onboard, codebase:onboard.'),
    includeMetrics: tool.schema.boolean().optional().describe('Include metrics.* memories in the listing.'),
  },
  execute: async (args: MemoirRecallArgs) => {
    const store = deriveStorePath();
    try {
      await ensureStore(store);
    } catch (error) {
      return String((error as Error).message || error);
    }

    const namespaces = args.namespace
      ? [args.namespace]
      : (args.namespaces && args.namespaces.length > 0 ? args.namespaces : DEFAULT_RECALL_NAMESPACES);
    const sections: string[] = [];
    for (const namespace of namespaces) {
      const output = tryPrettyJson(await runMemoir(['--json', '-s', store, 'summarize', '--depth', '3', '-n', namespace], { cwd: store }));
      sections.push(`## namespace: ${namespace}\n${output}`);
    }
    const note = args.includeMetrics
      ? 'Metrics were included by request.'
      : 'Ignore metrics.* and taxonomy:v1:* entries unless explicitly needed. If default is empty or only metrics, inspect project:onboard/codebase:onboard before concluding there is no memory.';
    const query = args.query ? `Query: ${args.query}\n` : '';
    return `${query}${note}\nPick at most 5-7 relevant exact keys across namespaces, then call memoir_get with the matching namespace if values are needed.\n${sections.join('\n\n')}`;
  },
});

const memoirGet = tool({
  description: 'Fetch exact Memoir memory keys after selecting them from memoir_recall output.',
  args: {
    keys: tool.schema.array(tool.schema.string()).describe('Exact memory keys to fetch.'),
    namespace: tool.schema.string().optional().describe('Memoir namespace. Defaults to default.'),
  },
  execute: async (args: MemoirGetArgs) => {
    const keys = args.keys?.map((key) => key.trim()).filter(Boolean) ?? [];
    if (keys.length === 0) return 'No Memoir keys were provided.';
    if (keys.length > MEMOIR_GET_MAX_KEYS) {
      return `Error: Too many keys requested (max ${MEMOIR_GET_MAX_KEYS}, got ${keys.length}). Narrow your selection from memoir_recall output.`;
    }

    const store = deriveStorePath();
    try {
      await ensureStore(store);
    } catch (error) {
      return String((error as Error).message || error);
    }

    return tryPrettyJson(await runMemoir(['--json', '-s', store, 'get', ...keys, '-n', args.namespace ?? 'default'], { cwd: store }));
  },
});

const MemoirOpenCode: Plugin = async (_input, rawOptions) => {
  const opts = (rawOptions ?? {}) as { store?: string };
  if (opts.store) setPluginStoreOverride(opts.store);

  // Resolve store path once at init so shell.env doesn't call execFileSync
  // on every shell command (mirrors Claude Code's MEMOIR_STORE_PATH caching).
  const storeRoot = deriveStorePath();

  return ({
  name: 'memoir',
  tool: {
    memoir_status: memoirStatus,
    memoir_remember: memoirRemember,
    memoir_recall: memoirRecall,
    memoir_get: memoirGet,
  },
  config: async (opencodeConfig: OpenCodeConfig) => {
    registerCommands(opencodeConfig);
  },
  'command.execute.before': async (input: { command?: string }, output: CommandOutput) => {
    try {
      if (input.command === 'memoir:status') {
        pushText(output, await statusJson(deriveStorePath()));
      }
      if (input.command === 'memoir:ui') {
        pushText(output, await launchUi(deriveStorePath()));
      }
      if (input.command === 'memoir:unmerged') {
        const store = deriveStorePath();
        await ensureStore(store);
        const raw = await runMemoir(['--json', '-s', store, 'branch'], { cwd: store });
        const data = JSON.parse(raw);
        const branches: string[] = data?.branches ?? [];
        const unmerged: string[] = [];
        for (const branch of branches) {
          if (branch === 'main') continue;
          const diffOut = await runMemoir(['-s', store, 'diff', branch, 'main', '--stat'], { cwd: store }).catch(() => '');
          if (diffOut.trim()) {
            unmerged.push(branch);
          }
        }
        pushText(output,
          unmerged.length > 0
            ? `Unmerged branches:\n${unmerged.join('\n')}`
            : 'All branches are merged into main.'
        );
      }
    } catch (error) {
      pushText(output, `Memoir command failed: ${String((error as Error).message || error)}`);
    }
  },

  /**
   * Inject MEMOIR_STORE into every shell command's environment so any memoir
   * invocation automatically targets the right store without manual -s flags.
   * Uses the cached value resolved at init time (avoiding execFileSync overhead
   * on every shell command).
   */
  'shell.env': async (_input, output) => {
    try {
      output.env.MEMOIR_STORE = storeRoot;
    } catch (e) {
      debugLog('shell.env: failed:', e instanceof Error ? e.message : String(e));
    }
  },

  /**
   * Observe every tool execution for metrics and code-change tracking.
   * Mirrors the observation phase of Claude Code's Stop hook.
   * Never modifies the tool output.
   */
  'tool.execute.after': async (input, output) => {
    try {
      // Per-session state key
      const sid = input.sessionID ?? 'default';

      // Accumulate per-tool metrics (cf. collect-metrics.sh).
      // Skipped when MEMOIR_NO_CAPTURE or MEMOIR_NO_METRICS is set.
      if (process.env.MEMOIR_NO_CAPTURE !== '1' && process.env.MEMOIR_NO_METRICS !== '1') {
        const calls = 1;
        const errors = (output.metadata?.error || output.output?.startsWith('Error:')) ? 1 : 0;
        recordToolMetrics(sid, input.tool, { calls, errors });
      }

      // Track file edits (cf. collect-edits.sh).
      // Skipped when MEMOIR_NO_CAPTURE or MEMOIR_NO_CODE_SUMMARY is set.
      if (process.env.MEMOIR_NO_CAPTURE !== '1' && process.env.MEMOIR_NO_CODE_SUMMARY !== '1' && EDIT_TOOLS.has(input.tool)) {
        const filePath =
          typeof input.args?.filePath === 'string' ? input.args.filePath
          : typeof input.args?.path === 'string' ? input.args.path
          : '';
        if (filePath) {
          recordEdit(sid, { tool: input.tool, filePath, snippet: '', timestamp: Date.now() });
        }
      }
    } catch (e) {
      debugLog('tool.execute.after: failed:', e instanceof Error ? e.message : String(e));
    }
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
    try {
      const sid = input.sessionID ?? 'default';

      // C4: run recall gate BEFORE any await — otherwise system.transform
      // could fire before pendingRecall is set.
      const text = output.parts
        .filter((p): p is typeof p & { type: 'text'; text: string } => p.type === 'text')
        .map(p => p.text)
        .join(' ');
      if (shouldTriggerRecall(text)) {
        pendingRecall.add(sid);
      }

      // Snapshot previous branch BEFORE switching — edits from the last turn
      // belong to the OLD branch. (C2 fix: prevents misattribution when the
      // user switches git branch between turns.)
      const prevBranch = getCachedBranch(sid) === 'unknown' ? undefined : getCachedBranch(sid);
      setCachedBranch(sid, await autoMatchMemoirBranch(storeRoot));

      // Skip capture flush when MEMOIR_NO_CAPTURE is set.
      // Flush under the PREVIOUS branch (the one edits were made on).
      if (process.env.MEMOIR_NO_CAPTURE !== '1') {
        await flushCapture(storeRoot, prevBranch, sid);
      }
    } catch (e) {
      debugLog('chat.message: failed:', e instanceof Error ? e.message : String(e));
    }
  },

  /**
   * Fires on SDK events. On session.created, kick off a background fetch of
   * the taxonomy overview so it's ready before the first LLM call.
   * Mirrors Claude Code's SessionStart context injection.
   */
  event: async ({ event: evt }: { event: { type: string } }) => {
    if (evt.type === 'session.created' && !initContextFetched) {
      initContextFetched = true;
      (async () => {
        try {
          const taxonomy = await runMemoir(
            ['--json', '-s', storeRoot, 'summarize', '--depth', '3', '-n', 'default'],
            { cwd: storeRoot }
          );
          if (taxonomy.startsWith('Memoir command failed')) {
            throw new Error(taxonomy);
          }
          const pretty = tryPrettyJson(taxonomy);
          initContext = `[memoir] Available taxonomy paths:\n${pretty}`;
        } catch (e: unknown) {
          debugLog('event: taxonomy fetch failed, will retry on next session:', e instanceof Error ? e.message : String(e));
          // Allow a later session to retry — the store may not have been ready yet.
          initContextFetched = false;
        }
      })();
    }
  },

  /**
   * Fires before every LLM call.
   *
   * 1. Injects the memoir taxonomy context for this session (once per session).
   * 2. If a recall is pending for this session, injects a brief instruction
   *    telling the model to use memoir tools (one-shot per trigger).
   */
  'experimental.chat.system.transform': async (input, output) => {
    try {
      // Inject initial context on the first LLM call of each session
      if (input.sessionID && !hasSessionContext(input.sessionID)) {
        markSessionContext(input.sessionID);
        if (initContext) {
          output.system.unshift(initContext);
        }
      }

      // Inject recall instruction (one-shot per trigger)
      if (input.sessionID && pendingRecall.has(input.sessionID)) {
        pendingRecall.delete(input.sessionID);
        output.system.push(
          '\n[memoir] The user may have relevant context in Memoir. Run memoir_recall to list available memories across default and onboard namespaces, then memoir_get with the matching namespace to fetch exact values.'
        );
      }
    } catch (e) {
      debugLog('system.transform: failed:', e instanceof Error ? e.message : String(e));
    }
  },

  /**
   * Fires when the plugin is shut down. Flushes any remaining code changes
   * and metrics (cf. SessionEnd heartbeat cleanup + final metrics flush).
   */
  dispose: async () => {
    // No sessionID → flushCapture flushes ALL sessions
    await flushCapture(storeRoot);
    pruneStaleSessions();
    sessionsWithContext.clear();
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
