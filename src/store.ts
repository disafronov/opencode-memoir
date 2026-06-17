import { execFile, execFileSync } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { debugLog } from "./debug.js";
import { errorMessage } from "./utils.js";

const execFileAsync = promisify(execFile);

export const MEMOIR_PACKAGE = "memoir-ai";

/**
 * Pinned memoir-ai version for uvx/uv fallbacks.
 * Mirrors plugins/claude-code/scripts/resolve-memoir-cli.sh.
 * Bump deliberately after verifying the new release works with this plugin.
 */
export const MEMOIR_AI_PIN = "0.2.2";

/** Timeout (ms) for synchronous git subprocess calls. */
export const GIT_TIMEOUT_MS = 3_000;

/** Timeout (ms) for async memoir CLI calls. */
export const MEMOIR_TIMEOUT_MS = 15_000;

/** Max stdout/stderr buffer (bytes) for async memoir CLI calls. */
export const MEMOIR_MAX_BUFFER = 1_024 * 1_024;

export type SpawnSpec = { command: string; args: string[]; label: string };

export type MemoirResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string; resolver?: string };

/** Max entries in _noGitCache before eviction. */
const NO_GIT_CACHE_MAX = 500;

/** TTL for non-git cache entries (5 minutes). */
const NO_GIT_CACHE_TTL = 5 * 60 * 1_000;

/** Evict the oldest entry (first inserted) from the noGitCache. */
function evictOldestNoGit(): void {
  const firstKey = _noGitCache.keys().next().value;
  if (firstKey !== undefined) _noGitCache.delete(firstKey);
}

/** Sweep expired entries from noGitCache. */
function sweepNoGitCache(): void {
  const now = Date.now();
  for (const [key, ts] of _noGitCache) {
    if (now - ts >= NO_GIT_CACHE_TTL) _noGitCache.delete(key);
  }
}

/**
 * Cache of cwds confirmed to be outside a git repo, keyed by path with
 * timestamp of when the entry was added.
 * Avoids redundant ~200ms failing `git rev-parse` calls on non-git directories,
 * while still allowing a directory that becomes a git repo (e.g. `git init`)
 * to be retried after the TTL expires.
 */
export const _noGitCache = new Map<string, number>();

/**
 * Check whether a cwd is cached as non-git and still within TTL.
 * If the entry exists but is expired, it is removed from the cache.
 */
export function _checkNoGit(cwd: string): boolean {
  const ts = _noGitCache.get(cwd);
  if (ts === undefined) return false;
  const age = Date.now() - ts;
  if (age < NO_GIT_CACHE_TTL) return true;
  // Expired — remove so the directory can be re-checked
  _noGitCache.delete(cwd);
  return false;
}

/**
 * Resolve the main worktree root path for a git repository.
 * Mirrors _main_worktree_root from plugins/claude-code/scripts/derive-store-path.sh.
 *
 * @returns The main worktree path, or empty string if not in a git repo.
 */
export function _main_worktree_root(cwd: string): string {
  if (_checkNoGit(cwd)) return "";
  try {
    // Fast path: check if --git-dir and --git-common-dir resolve to the same path
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    }).trim();

    // Resolve to absolute paths
    const resolvePath = (path: string): string => {
      if (path.startsWith("/")) return path;
      return join(cwd, path);
    };
    const gitDirAbs = resolvePath(gitDir);
    const gitCommonDirAbs = resolvePath(gitCommonDir);

    if (gitDirAbs === gitCommonDirAbs) {
      // Main worktree or non-worktree repo
      return execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
      }).trim();
    }

    // Slow path: parse `git worktree list --porcelain` for the main worktree
    const worktreeList = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    const firstLine = worktreeList.split("\n")[0];
    if (firstLine.startsWith("worktree ")) {
      const mainWorktree = firstLine.substring("worktree ".length).trim();
      if (mainWorktree && mainWorktree !== "(bare)") {
        return mainWorktree;
      }
    }

    // Fallback: try --show-toplevel (bare repo or older git)
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch (e) {
    debugLog("_main_worktree_root: not a git repo or git error:", errorMessage(e));
    sweepNoGitCache();
    _noGitCache.set(cwd, Date.now());
    if (_noGitCache.size > NO_GIT_CACHE_MAX) evictOldestNoGit();
    return "";
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
    debugLog("deriveStorePath: unexpected error:", errorMessage(e));
    // Fallback to raw cwd if everything else fails
    projectDir = cwd;
  }

  // Slug = absolute path with '/' and '.' replaced by '-'
  // Matches Claude Code's own ~/.claude/projects/ naming convention
  const slug = projectDir.replace(/[/.]/g, "-");
  return join(homedir(), ".memoir", slug);
}

/** Set by plugin options (`store` key). */
export let pluginStoreOverride: string | undefined;

/** Set `pluginStoreOverride` from plugin init. Exported as a function
 *  because ES module imports are read-only bindings (direct assignment
 *  from another module is a TS2632 error). */
export function setPluginStoreOverride(store: string | undefined): void {
  pluginStoreOverride = store;
}

/** Max entries in ensuredStores before eviction. */
const ENSURED_STORES_MAX = 200;

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
    await access(join(store, ".git"));
    ensuredStores.add(store);
    if (ensuredStores.size > ENSURED_STORES_MAX) ensuredStores.clear();
    return; // already exists
  } catch {
    // ensure parent dir exists (memoir new doesn't create intermediate dirs)
    await mkdir(join(store, ".."), { recursive: true }).catch((e: unknown) =>
      debugLog("ensureStore: mkdir failed:", errorMessage(e)),
    );
  }

  // Register this creation so concurrent callers coallesce
  const creationPromise = (async () => {
    const tmpDir = join(tmpdir(), `memoir-scratch-${Date.now()}`);
    try {
      await mkdir(tmpDir, { recursive: true });
      await execFileAsync("git", ["init", "-q", tmpDir], { timeout: 5000 });
      const result = await runMemoir(["new", store, "--taxonomy-builtin"], { cwd: tmpDir });
      if (!result.ok) {
        throw new Error(result.error);
      }
      ensuredStores.add(store);
      if (ensuredStores.size > ENSURED_STORES_MAX) ensuredStores.clear();
    } catch (e: unknown) {
      debugLog("ensureStore: creation failed:", errorMessage(e));
      throw e;
    } finally {
      rm(tmpDir, { recursive: true, force: true }).catch((e) =>
        debugLog("tmp cleanup failed:", errorMessage(e)),
      );
    }
  })();
  storeCreations.set(store, creationPromise);
  try {
    await creationPromise;
  } finally {
    storeCreations.delete(store);
  }
}

/**
 * Reorder a cached resolver list so that `winner` is first.
 * Returns a new array (does not mutate the input).
 */
export function reorderResolver<T>(resolver: T[], winner: T): T[] {
  const idx = resolver.indexOf(winner);
  if (idx <= 0) return [...resolver];
  const next = [...resolver];
  next.splice(idx, 1);
  next.unshift(winner);
  return next;
}

/** Which CLI launcher successfully resolved memoir. Cached to avoid redundant fallback probing. */
export let memoirResolved: string | null = null;

export async function runMemoir(
  args: string[],
  options: { cwd?: string } = {},
): Promise<MemoirResult> {
  let specs = memoirSpawnSpecs(args);

  // Put cached resolver first so we skip redundant fallback probing
  if (memoirResolved) {
    const winner = specs.find((s) => s.label === memoirResolved);
    if (winner) specs = reorderResolver(specs, winner);
  }

  let lastError = "";
  let lastResolver: string | undefined;
  for (const spec of specs) {
    try {
      const { stdout } = await execFileAsync(spec.command, spec.args, {
        cwd: options.cwd ?? process.cwd(),
        env: process.env,
        maxBuffer: MEMOIR_MAX_BUFFER,
        timeout: MEMOIR_TIMEOUT_MS, // prevent hang if memoir CLI stalls
      });
      memoirResolved = spec.label;
      return { ok: true, stdout: stdout.trim() };
    } catch (e) {
      lastError = errorMessage(e);
      lastResolver = spec.label;
      debugLog("runMemoir: fallback", spec.label, "failed:", lastError);
      // Invalidate cache so we don't keep trying a broken resolver on next call
      if (memoirResolved === spec.label) memoirResolved = null;
    }
  }

  return { ok: false, error: `Memoir command failed: ${lastError}`, resolver: lastResolver };
}

export function memoirSpawnSpecs(args: string[]): SpawnSpec[] {
  return [
    { command: "memoir", args, label: "memoir" },
    {
      command: "uvx",
      args: ["--from", `${MEMOIR_PACKAGE}==${MEMOIR_AI_PIN}`, "memoir", ...args],
      label: "uvx",
    },
    {
      command: "uv",
      args: ["tool", "run", "--from", `${MEMOIR_PACKAGE}==${MEMOIR_AI_PIN}`, "memoir", ...args],
      label: "uv tool run",
    },
  ];
}

/** Read the current memoir branch name for use in storage keys. */
export async function getCurrentBranch(store: string): Promise<string> {
  try {
    const runFn = _storeTestOverrides.runMemoirFn ?? runMemoir;
    const result = await runFn(["--json", "-s", store, "status"], { cwd: store });
    if (!result.ok) return "unknown";
    const data = JSON.parse(result.stdout);
    return data.branch || "unknown";
  } catch (e) {
    debugLog("getCurrentBranch: failed:", errorMessage(e));
    return "unknown";
  }
}

/**
 * Return the current git branch of the user's project (from cwd).
 * Empty string if not in a git repo or detached HEAD.
 * Mirrors code_git_branch from plugins/claude-code/hooks/common.sh.
 */
export async function codeGitBranch(): Promise<string> {
  try {
    const execFn = _storeTestOverrides.execFileAsyncFn ?? execFileAsync;
    const { stdout } = await execFn("git", ["branch", "--show-current"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch (e) {
    debugLog("codeGitBranch: failed:", errorMessage(e));
    return "";
  }
}

/**
 * Check whether a branch exists in the memoir store.
 * Mirrors branch_exists_in_memoir from plugins/claude-code/hooks/common.sh.
 */
export async function branchExistsInMemoir(store: string, name: string): Promise<boolean> {
  if (!name) return false;
  try {
    const runFn = _storeTestOverrides.runMemoirFn ?? runMemoir;
    const result = await runFn(["--json", "-s", store, "branch"], { cwd: store });
    if (!result.ok) return false;
    const data = JSON.parse(result.stdout);
    const branches: string[] = data?.branches ?? [];
    return branches.includes(name);
  } catch (e) {
    debugLog("branchExistsInMemoir: failed:", errorMessage(e));
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
  const runFn = _storeTestOverrides.runMemoirFn ?? runMemoir;
  const codeBranch = await codeGitBranch();
  if (!codeBranch) {
    return getCurrentBranch(store); // detached or non-git — just report current
  }

  const current = await getCurrentBranch(store);
  if (current === codeBranch) return current; // already matched

  // Create the branch from main if it doesn't exist yet
  if (!(await branchExistsInMemoir(store, codeBranch))) {
    const result = await runFn(["-s", store, "branch", codeBranch, "--from", "main"], {
      cwd: store,
    });
    if (!result.ok) {
      debugLog("autoMatchMemoirBranch: create branch failed:", result.error);
      return getCurrentBranch(store);
    }
  }
  // Checkout the branch
  const result = await runFn(["-s", store, "checkout", codeBranch], { cwd: store });
  if (!result.ok) {
    debugLog("autoMatchMemoirBranch: checkout failed:", result.error);
    return getCurrentBranch(store);
  }
  return codeBranch;
}

/**
 * Read the content of a single memoir key (first item found).
 * Returns empty string if key doesn't exist or on error.
 */
export async function readMemoirValue(
  store: string,
  key: string,
  namespace: string = "default",
): Promise<string> {
  try {
    const runFn = _storeTestOverrides.runMemoirFn ?? runMemoir;
    const result = await runFn(["--json", "-s", store, "get", key, "-n", namespace], {
      cwd: store,
    });
    if (!result.ok) return "";
    const parsed = JSON.parse(result.stdout);
    const items = parsed?.items ?? [];
    const value = items[0]?.value?.content;
    return typeof value === "string" ? value : "";
  } catch (e) {
    debugLog("readMemoirValue: failed:", errorMessage(e));
    return "";
  }
}

// --- Test seams (only for unit tests) ---
type StoreTestOverrides = {
  runMemoirFn?: (args: string[], options: { cwd?: string }) => Promise<MemoirResult>;
  execFileAsyncFn?: (
    command: string,
    args: string[],
    options?: Record<string, unknown>,
  ) => Promise<{ stdout: string }>;
};
let _storeTestOverrides: StoreTestOverrides = {};
export function setStoreTestOverrides(overrides: StoreTestOverrides): void {
  _storeTestOverrides = overrides;
}
