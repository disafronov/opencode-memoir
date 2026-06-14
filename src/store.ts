import { execFile, execFileSync } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { debugLog } from './debug.js';
import { errorMessage } from './utils.js';

const execFileAsync = promisify(execFile);

export const MEMOIR_PACKAGE = 'memoir-ai';

/**
 * Pinned memoir-ai version for uvx/uv fallbacks.
 * Mirrors plugins/claude-code/scripts/resolve-memoir-cli.sh.
 * Bump deliberately after verifying the new release works with this plugin.
 */
export const MEMOIR_AI_PIN = '0.2.2';

export type SpawnSpec = { command: string; args: string[]; label: string };

/**
 * Cache of cwds confirmed to be outside a git repo.
 * Avoids redundant ~200ms failing `git rev-parse` calls on non-git directories.
 */
export const _noGitCache = new Set<string>();

/**
 * Resolve the main worktree root path for a git repository.
 * Mirrors _main_worktree_root from plugins/claude-code/scripts/derive-store-path.sh.
 *
 * @returns The main worktree path, or empty string if not in a git repo.
 */
export function _main_worktree_root(cwd: string): string {
  if (_noGitCache.has(cwd)) return '';
  try {
    // Fast path: check if --git-dir and --git-common-dir resolve to the same path
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd, encoding: 'utf8', timeout: 3000 }).trim();
    const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 3000 }).trim();

    // Resolve to absolute paths
    const resolvePath = (path: string): string => {
      if (path.startsWith('/')) return path;
      return join(cwd, path);
    };
    const gitDirAbs = resolvePath(gitDir);
    const gitCommonDirAbs = resolvePath(gitCommonDir);

    if (gitDirAbs === gitCommonDirAbs) {
      // Main worktree or non-worktree repo
      return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 3000 }).trim();
    }

    // Slow path: parse `git worktree list --porcelain` for the main worktree
    const worktreeList = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8', timeout: 3000 });
    const firstLine = worktreeList.split('\n')[0];
    if (firstLine.startsWith('worktree ')) {
      const mainWorktree = firstLine.substring('worktree '.length).trim();
      if (mainWorktree && mainWorktree !== '(bare)') {
        return mainWorktree;
      }
    }

    // Fallback: try --show-toplevel (bare repo or older git)
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 3000 }).trim();
  } catch (e) {
    debugLog('_main_worktree_root: not a git repo or git error:', errorMessage(e));
    _noGitCache.add(cwd);
    return '';
  }
}

/**
 * Derive `~/.memoir/<slug>` from cwd.
 * Override via `store` plugin option or `MEMOIR_STORE` env var.
 *
 * Resolution order (mirrors plugins/claude-code/scripts/derive-store-path.sh):
 *   1. Plugin option override
 *   2. MEMOIR_STORE env var
 *   3. Git root (realpath) — all worktrees of a repo share one store
 *   4. `path.resolve()` of cwd — normalized deterministic slug for non-git folders
 *   5. Raw cwd fallback
 */
export function deriveStorePath(cwd: string = process.cwd()): string {
  if (pluginStoreOverride) return pluginStoreOverride;
  const configured = process.env.MEMOIR_STORE;
  if (configured) return configured;

  // Prefer git root so all subdirectories and worktrees share one store
  let projectDir: string;
  try {
    const gitRoot = _main_worktree_root(cwd);
    if (gitRoot) {
      projectDir = gitRoot;
    } else {
      // Not in git — normalize to deterministic absolute path
      projectDir = resolve(cwd);
    }
  } catch (e) {
    debugLog('deriveStorePath: unexpected error:', e instanceof Error ? e.message : String(e));
    // Fallback to raw cwd if everything else fails
    projectDir = cwd;
  }

  // Slug = absolute path with '/' and '.' replaced by '-'
  // Matches Claude Code's own ~/.claude/projects/ naming convention
  const slug = projectDir.replace(/[/.]/g, '-');
  return join(homedir(), '.memoir', slug);
}

/** Set by plugin options (`store` key). */
export let pluginStoreOverride: string | undefined;

/** Set `pluginStoreOverride` from plugin init. Exported as a function
 *  because ES module imports are read-only bindings (direct assignment
 *  from another module is a TS2632 error). */
export function setPluginStoreOverride(store: string | undefined): void {
  pluginStoreOverride = store;
}

/** Cache of stores already verified or created — avoids redundant access() + CLI calls. */
export const ensuredStores = new Set<string>();

/**
 * Stores currently being created — prevents concurrent `memoir new` on
 * the same path (C5 fix).
 */
const storeCreations = new Map<string, Promise<void>>();

export async function ensureStore(store: string): Promise<void> {
  if (ensuredStores.has(store)) return;

  // If another caller is already creating this store, await it
  const inFlight = storeCreations.get(store);
  if (inFlight) {
    await inFlight;
    return;
  }

  try {
    await access(join(store, '.git'));
    ensuredStores.add(store);
    return; // already exists
  } catch {
    // ensure parent dir exists (memoir new doesn't create intermediate dirs)
    await mkdir(join(store, '..'), { recursive: true }).catch((e: unknown) => debugLog('ensureStore: mkdir failed:', e instanceof Error ? e.message : String(e)));
  }

  // Register this creation so concurrent callers coallesce
  const creationPromise = (async () => {
    const tmpDir = join(tmpdir(), `memoir-scratch-${Date.now()}`);
    try {
      await mkdir(tmpDir, { recursive: true });
      await execFileAsync('git', ['init', '-q', tmpDir], { timeout: 5000 });
      const result = await runMemoir(['new', store, '--taxonomy-builtin'], { cwd: tmpDir });
      if (result.startsWith('Memoir command failed')) {
        throw new Error(result);
      }
      ensuredStores.add(store);
    } finally {
      rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  })();
  storeCreations.set(store, creationPromise);
  try {
    await creationPromise;
  } finally {
    storeCreations.delete(store);
  }
}

/** Which CLI launcher successfully resolved memoir. Cached to avoid redundant fallback probing. */
export let memoirResolved: string | null = null;

export async function runMemoir(args: string[], options: { cwd?: string } = {}): Promise<string> {
  const specs = memoirSpawnSpecs(args);

  // Put cached resolver first so we skip redundant fallback probing
  if (memoirResolved) {
    const idx = specs.findIndex(s => s.label === memoirResolved);
    if (idx > 0) {
      const [cached] = specs.splice(idx, 1);
      specs.unshift(cached);
    }
  }

  for (const spec of specs) {
    try {
      const { stdout } = await execFileAsync(spec.command, spec.args, {
        cwd: options.cwd ?? process.cwd(),
        env: process.env,
        maxBuffer: 1024 * 1024,
        timeout: 15_000, // prevent hang if memoir CLI stalls
      });
      memoirResolved = spec.label;
      return stdout.trim();
    } catch (e) {
      debugLog('runMemoir: fallback', spec.label, 'failed:', e instanceof Error ? e.message : String(e));
      // Invalidate cache so we don't keep trying a broken resolver on next call
      if (memoirResolved === spec.label) memoirResolved = null;
    }
  }

  // Build a fallback-free attempt at memoir direct for the error message
  try {
    const { stdout } = await execFileAsync('memoir', args, {
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    });
    return stdout.trim(); // shouldn't get here since all specs failed, but defensive
  } catch (memoirError) {
    const err = memoirError as Error & { stdout?: string; stderr?: string; code?: number };
    const detail = (err.stderr || err.stdout || err.message).trim();
    return `Memoir command failed${err.code ? ` (${err.code})` : ''}: ${detail}`;
  }
}

export function memoirSpawnSpecs(args: string[]): SpawnSpec[] {
  return [
    { command: 'memoir', args, label: 'memoir' },
    { command: 'uvx', args: ['--from', `${MEMOIR_PACKAGE}==${MEMOIR_AI_PIN}`, 'memoir', ...args], label: 'uvx' },
    { command: 'uv', args: ['tool', 'run', '--from', `${MEMOIR_PACKAGE}==${MEMOIR_AI_PIN}`, 'memoir', ...args], label: 'uv tool run' },
  ];
}

/** Read the current memoir branch name for use in storage keys. */
export async function getCurrentBranch(store: string): Promise<string> {
  try {
    const raw = await runMemoir(['--json', '-s', store, 'status'], { cwd: store });
    const data = JSON.parse(raw);
    return data.branch || 'unknown';
  } catch (e) {
    debugLog('getCurrentBranch: failed:', e instanceof Error ? e.message : String(e));
    return 'unknown';
  }
}

/**
 * Return the current git branch of the user's project (from cwd).
 * Empty string if not in a git repo or detached HEAD.
 * Mirrors code_git_branch from plugins/claude-code/hooks/common.sh.
 */
export async function codeGitBranch(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { encoding: 'utf8', timeout: 3000 });
    return stdout.trim();
  } catch (e) {
    debugLog('codeGitBranch: failed:', errorMessage(e));
    return '';
  }
}

/**
 * Check whether a branch exists in the memoir store.
 * Mirrors branch_exists_in_memoir from plugins/claude-code/hooks/common.sh.
 */
export async function branchExistsInMemoir(store: string, name: string): Promise<boolean> {
  if (!name) return false;
  try {
    const raw = await runMemoir(['--json', '-s', store, 'branch'], { cwd: store });
    const data = JSON.parse(raw);
    const branches: string[] = data?.branches ?? [];
    return branches.includes(name);
  } catch (e) {
    debugLog('branchExistsInMemoir: failed:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * Auto-match memoir branch to the current code git branch.
 * If the code branch differs from the memoir branch, creates the memoir branch
 * (forked from main) if needed and checks it out.
 * Mirrors auto_match_memoir_branch from plugins/claude-code/hooks/common.sh.
 */
export async function autoMatchMemoirBranch(store: string): Promise<string> {
  const codeBranch = await codeGitBranch();
  if (!codeBranch) {
    return getCurrentBranch(store); // detached or non-git — just report current
  }

  const current = await getCurrentBranch(store);
  if (current === codeBranch) return current; // already matched

  // Create the branch from main if it doesn't exist yet
  if (!(await branchExistsInMemoir(store, codeBranch))) {
    const result = await runMemoir(['-s', store, 'branch', codeBranch, '--from', 'main'], { cwd: store });
    if (result.startsWith('Memoir command failed')) {
      debugLog('autoMatchMemoirBranch: create branch failed:', result);
      return getCurrentBranch(store);
    }
  }
  // Checkout the branch
  const result = await runMemoir(['-s', store, 'checkout', codeBranch], { cwd: store });
  if (result.startsWith('Memoir command failed')) {
    debugLog('autoMatchMemoirBranch: checkout failed:', result);
    return getCurrentBranch(store);
  }
  return codeBranch;
}

/**
 * Read the content of a single memoir key (first item found).
 * Returns empty string if key doesn't exist or on error.
 */
export async function readMemoirValue(store: string, key: string, namespace: string = 'default'): Promise<string> {
  try {
    const raw = await runMemoir(['--json', '-s', store, 'get', key, '-n', namespace], { cwd: store });
    const parsed = JSON.parse(raw);
    const items = parsed?.items ?? [];
    const value = items[0]?.value?.content;
    return typeof value === 'string' ? value : '';
  } catch (e) {
    debugLog('readMemoirValue: failed:', e instanceof Error ? e.message : String(e));
    return '';
  }
}
