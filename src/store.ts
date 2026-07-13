import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callMemoirTool } from "./mcp-client.js";

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

export async function autoMatchMemoirBranch(client: Client, sessionID: string): Promise<void> {
  const codeBranch = currentGitBranch();
  if (!codeBranch) return;

  const cached = getCachedBranch(sessionID);
  if (cached === codeBranch) return;

  // memoir_checkout (per the v0.2.4 contract) switches to a branch, creating
  // it on demand when `create` is true. A single call replaces the old
  // branches-list → branch → checkout CLI sequence.
  const result = await callMemoirTool(client, "memoir_checkout", {
    target: codeBranch,
    create: true,
  });
  if (result !== null) {
    setCachedBranch(sessionID, codeBranch);
  }
}

export function pruneBranchCache(): void {
  branchCache.clear();
}
