import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Resolve a path through symlinks, falling back to the input on failure. */
export function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Turn an absolute path into a filesystem-safe slug for store naming. */
export function slugify(p: string): string {
  return p.replace(/[/.]/g, "-");
}

/**
 * Resolve the memoir store path.
 *  1. `override` (plugin `store` option)
 *  2. MEMOIR_STORE env var
 *  3. Git root → `~/.memoir/<slug>` (all worktrees share one store)
 *  4. Resolved cwd → `~/.memoir/<slug>` for non-git dirs
 *
 * The project directory is realpath'd before slugifying so the store is
 * identical whether the repo is entered via a symlink or its real path.
 */
export function deriveStorePath(cwd: string = process.cwd(), override?: string): string {
  if (override) return override;
  const envStore = process.env.MEMOIR_STORE;
  if (envStore) return envStore;

  const realCwd = safeRealpath(cwd);
  let projectDir: string;
  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: realCwd,
      encoding: "utf8",
      timeout: 3_000,
    }).trim();
    projectDir = safeRealpath(gitRoot);
  } catch {
    projectDir = resolve(realCwd);
  }

  return join(homedir(), ".memoir", slugify(projectDir));
}
