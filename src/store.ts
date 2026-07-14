import { execFileSync } from "node:child_process";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callMemoirTool } from "./mcp-client.js";
import { deriveStorePath as deriveStorePathBase, safeRealpath } from "./path.js";

/** Resolve the memoir store path, honoring the plugin `store` option override. */
export function deriveStorePath(cwd?: string, override?: string): string {
  return deriveStorePathBase(cwd, override);
}

/** Get current git branch (empty string if not in a git repo). */
export function currentGitBranch(cwd = process.cwd()): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: safeRealpath(cwd),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Track the actual branch of one memoir store. The checkout is store-global,
 * so a per-session cache would become stale as soon as another session changed
 * the branch.
 */
export class MemoirBranchMatcher {
  private matching: Promise<void> = Promise.resolve();

  match(client: Client, cwd: string, drain?: () => Promise<boolean>): Promise<void> {
    const next = this.matching.then(() => this.matchNow(client, cwd, drain));
    this.matching = next.catch(() => undefined);
    return next;
  }

  private async currentBranch(client: Client): Promise<string> {
    const raw = await callMemoirTool(client, "memoir_status");
    if (!raw) return "";
    try {
      const status = JSON.parse(raw) as { branch?: unknown };
      return typeof status.branch === "string" ? status.branch : "";
    } catch {
      return "";
    }
  }

  private async matchNow(
    client: Client,
    cwd: string,
    drain?: () => Promise<boolean>,
  ): Promise<void> {
    const codeBranch = currentGitBranch(cwd);
    if (!codeBranch) return;

    if ((await this.currentBranch(client)) === codeBranch) return;
    if (drain && !(await drain())) return;
    // A capture or external client may have changed HEAD while we waited.
    if ((await this.currentBranch(client)) === codeBranch) return;

    // memoir_checkout (per the v0.2.4 contract) switches to a branch, creating
    // it on demand when `create` is true. A single call replaces the old
    // branches-list → branch → checkout CLI sequence.
    await callMemoirTool(client, "memoir_checkout", {
      target: codeBranch,
      create: true,
    });
  }

  clear(): void {
    this.matching = Promise.resolve();
  }
}
