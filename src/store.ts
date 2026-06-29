import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { debugLog } from "./debug.js";

const execFileAsync = promisify(execFile);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Resolve memoir store path.
 *  1. Plugin `store` option override
 *  2. MEMOIR_STORE env var
 *  3. Git root → `~/.memoir/<slug>` (all worktrees share one store)
 *  4. Resolved cwd → `~/.memoir/<slug>` for non-git dirs
 */
export function deriveStorePath(cwd = process.cwd()): string {
  if (pluginStoreOverride) return pluginStoreOverride;
  const envStore = process.env.MEMOIR_STORE;
  if (envStore) return envStore;

  let projectDir: string;
  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 3_000,
    }).trim();
    projectDir = gitRoot;
  } catch {
    projectDir = resolve(cwd);
  }

  const slug = projectDir.replace(/[/.]/g, "-");
  return join(homedir(), ".memoir", slug);
}

export let pluginStoreOverride: string | undefined;

export function setPluginStoreOverride(store: string | undefined): void {
  pluginStoreOverride = store;
}

/** Get current git branch (empty string if not in a git repo). */
export function currentGitBranch(cwd = process.cwd()): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      timeout: 3_000,
    }).trim();
  } catch {
    return "";
  }
}

const branchCache = new Map<string, string>();

export function getCachedBranch(sessionID: string): string {
  return branchCache.get(sessionID) ?? "";
}

export function setCachedBranch(sessionID: string, branch: string): void {
  branchCache.set(sessionID, branch);
}

/** Call the memoir CLI via uvx. */
export async function callMemoir(args: string[], store: string): Promise<string | null> {
  try {
    const { stdout } = (await execFileAsync(
      "uvx",
      ["--from", "memoir-ai", "memoir", "-s", store, ...args],
      {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1_024 * 1_024,
      },
    )) as { stdout: string };
    return stdout.trim();
  } catch (e) {
    debugLog("callMemoir failed:", errorMessage(e));
    return null;
  }
}

export async function autoMatchMemoirBranch(store: string, sessionID: string): Promise<void> {
  const codeBranch = currentGitBranch();
  if (!codeBranch) return;

  const cached = getCachedBranch(sessionID);
  if (cached === codeBranch) return;

  // Check if branch exists in memoir
  const branchResult = await callMemoir(["--json", "branch"], store);
  if (branchResult === null) return;

  try {
    const data = JSON.parse(branchResult);
    const branches: string[] = data?.branches ?? [];
    if (!branches.includes(codeBranch)) {
      await callMemoir(["branch", codeBranch, "--from", "main"], store);
    }
    await callMemoir(["checkout", codeBranch], store);
    setCachedBranch(sessionID, codeBranch);
  } catch (e) {
    debugLog("autoMatchMemoirBranch: parsing failed:", errorMessage(e));
  }
}

export function pruneBranchCache(): void {
  branchCache.clear();
}
