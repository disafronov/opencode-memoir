import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { debugLog } from "./debug.js";
import {
  codeGitBranch,
  ensureStore,
  memoirResolved,
  memoirSpawnSpecs,
  reorderResolver,
  runMemoir,
} from "./store.js";
import { errorMessage } from "./utils.js";

/** Timeout (ms) for UI URL detection polling. */
const UI_URL_DEADLINE_MS = 5_000;

/** Polling interval (ms) for UI URL detection. */
const UI_URL_POLL_MS = 100;

/** Max buffer size for UI output capture (256 KB). */
const UI_OUTPUT_MAX_BYTES = 256 * 1_024;

/** Ensure the memoir store exists, returning an error message on failure. */
export async function ensureStoreOrError(store: string): Promise<string | null> {
  try {
    await ensureStore(store);
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

export async function statusJson(store: string): Promise<string> {
  const storeErr = await ensureStoreOrError(store);
  if (storeErr) return `Memoir command failed: ${storeErr}`;
  const result = await runMemoir(["--json", "-s", store, "status"], { cwd: store });
  if (!result.ok) return result.error;
  try {
    const data = JSON.parse(result.stdout);
    const branch = await codeGitBranch();
    data.opencode = { store, project_git_root: process.cwd(), project_git_branch: branch };
    return JSON.stringify(data, null, 2);
  } catch (e) {
    debugLog("statusJson: failed to parse JSON:", errorMessage(e));
    return result.stdout;
  }
}

export async function launchUi(store: string): Promise<string> {
  await ensureStore(store);
  const pidDir = join(homedir(), ".memoir", "ui-servers");
  await mkdir(pidDir, { recursive: true });
  const hash = createHash("sha256").update(store).digest("hex").slice(0, 8);
  const pidfile = join(pidDir, `${hash}.json`);

  try {
    const existing = JSON.parse(await readFile(pidfile, "utf8"));
    if (existing?.pid && existing?.url) {
      try {
        process.kill(Number(existing.pid), 0); // check if alive
        return JSON.stringify({ ...existing, reused: true }, null, 2);
      } catch (e) {
        debugLog("launchUi: process dead, relaunching:", errorMessage(e));
        // process is dead — fall through to relaunch
      }
    }
  } catch (e) {
    debugLog("launchUi: failed to read pidfile:", errorMessage(e));
    await rm(pidfile, { force: true }).catch((e) =>
      debugLog("launchUi: failed to remove stale pidfile", errorMessage(e)),
    );
  }

  let lastError = "";
  let uiSpecs = memoirSpawnSpecs(["ui", store]);
  // Reorder: put cached memoir resolver first, same as runMemoir
  if (memoirResolved) {
    const winner = uiSpecs.find((s) => s.label === memoirResolved);
    if (winner) uiSpecs = reorderResolver(uiSpecs, winner);
  }
  for (const spec of uiSpecs) {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Scrub process.env — only forward whitelisted vars to avoid leaking secrets
      env: Object.fromEntries(
        Object.entries({
          HOME: process.env.HOME,
          USER: process.env.USER,
          PATH: process.env.PATH,
          MEMOIR_STORE: process.env.MEMOIR_STORE,
          MEMOIR_DEBUG: process.env.MEMOIR_DEBUG,
        }).filter(([, v]) => v != null),
      ) as Record<string, string>,
    });

    let output = "";
    child.stdout?.on("data", (chunk) => {
      if (output.length < UI_OUTPUT_MAX_BYTES) output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (output.length < UI_OUTPUT_MAX_BYTES) output += String(chunk);
    });

    const spawnFailed = new Promise<string | null>((resolve) => {
      child.once("error", (error) => resolve(errorMessage(error)));
      child.once("spawn", () => resolve(null));
    });
    const error = await spawnFailed;
    if (error) {
      lastError = `${spec.label}: ${error}`;
      continue;
    }

    child.unref();

    // Early-exit flag: process died before URL was found
    let childExited = false;
    child.once("exit", () => {
      childExited = true;
    });

    const urlPattern = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+\S*/;
    const deadline = Date.now() + UI_URL_DEADLINE_MS;
    while (Date.now() < deadline && !childExited) {
      const match = output.match(urlPattern);
      if (match) {
        const url = match[0];
        const data = {
          pid: child.pid,
          url,
          store,
          command: spec.label,
          started: new Date().toISOString(),
          reused: false,
        };
        await writeFile(pidfile, JSON.stringify(data, null, 2));
        return JSON.stringify(data, null, 2);
      }
      await new Promise((resolve) => setTimeout(resolve, UI_URL_POLL_MS));
    }

    if (childExited) {
      lastError =
        `${spec.label}: process exited before URL was detected. Output: ${output.slice(0, 500)}`.trim();
      continue;
    }

    const msg = `Memoir UI started with ${spec.label} (pid ${child.pid ?? "unknown"}), but URL was not detected yet.\n${output.trim()}`;
    return msg.trim();
  }

  return `Memoir UI failed to start: ${lastError || "no launcher succeeded"}`;
}

/** List memoir branches with unmerged changes relative to main. */
export async function unmergedBranchesText(store: string): Promise<string> {
  await ensureStore(store);
  const branchResult = await runMemoir(["--json", "-s", store, "branch"], { cwd: store });
  if (!branchResult.ok) {
    return branchResult.error;
  }
  const data = JSON.parse(branchResult.stdout);
  const branches: string[] = data?.branches ?? [];
  const unmerged: string[] = [];
  const diffResults = await Promise.all(
    branches
      .filter((b) => b !== "main")
      .map(async (branch) => {
        const diffResult = await runMemoir(["-s", store, "diff", branch, "main", "--stat"], {
          cwd: store,
        });
        return { branch, diffResult };
      }),
  );
  for (const { branch, diffResult } of diffResults) {
    if (!diffResult.ok) {
      debugLog("command.execute.before: memoir diff failed", diffResult.error);
      continue;
    }
    if (diffResult.stdout.trim()) {
      unmerged.push(branch);
    }
  }
  return unmerged.length > 0
    ? `Unmerged branches:\n${unmerged.join("\n")}`
    : "All branches are merged into main.";
}
