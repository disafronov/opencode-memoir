import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type CaptureSnapshot, prepareCaptureTurn } from "./capture.js";
import { log } from "./debug.js";
import { runMemoirSubagent } from "./subagent.js";

type CaptureCoordinatorOptions = {
  connectClient: () => Promise<Client | null>;
  matchBranch: (client: Client, drain: () => Promise<boolean>) => Promise<boolean>;
  currentBranch: () => Promise<string>;
  model: () => string | undefined;
};

type CaptureState = "queued" | "submitting" | "accepted" | "completed" | "failed";
type TerminalState = "completed" | "failed";
type CaptureTask = {
  key: string;
  parent: string;
  snapshot: CaptureSnapshot;
  state: CaptureState;
  attempts: number;
  branch?: string;
};
type ActiveCapture = {
  task: CaptureTask;
  done: Promise<void>;
  resolve: () => void;
  terminal?: TerminalState;
};

const MAX_ATTEMPTS = 2;
const RECENT_TURNS = 256;

/** Owns capture submission, completion, retry, and shutdown for one instance. */
export class CaptureCoordinator {
  private readonly tasks = new Map<string, CaptureTask>();
  // Terminal history contains no transcripts and is bounded for long sessions.
  private readonly recent = new Map<string, TerminalState>();
  private submissions: Promise<void> = Promise.resolve();
  private readonly activeCaptures = new Map<string, ActiveCapture>();
  private disposing = false;

  constructor(
    private readonly sdkClient: unknown,
    private readonly options: CaptureCoordinatorOptions,
  ) {}

  private deleteSession(sessionID: string): void {
    const api = (
      this.sdkClient as
        | {
            session?: { delete?: (input: { path: { id: string } }) => Promise<unknown> };
          }
        | null
        | undefined
    )?.session;
    if (api?.delete) {
      void api.delete({ path: { id: sessionID } }).catch((e: unknown) => {
        log("failed to delete completed capture session", sessionID, e);
      });
    }
  }

  private release(sessionID: string): ActiveCapture | undefined {
    const capture = this.activeCaptures.get(sessionID);
    if (!capture) return undefined;
    this.activeCaptures.delete(sessionID);
    capture.resolve();
    this.deleteSession(sessionID);
    return capture;
  }

  private remember(task: CaptureTask, state: TerminalState): void {
    task.state = state;
    this.tasks.delete(task.key);
    this.recent.set(task.key, state);
    if (this.recent.size > RECENT_TURNS) {
      const oldest = this.recent.keys().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
  }

  finish = (sessionID: string, state: TerminalState = "completed"): void => {
    const capture = this.activeCaptures.get(sessionID);
    if (!capture) return;
    // Events can arrive before promptAsync returns. Keep the branch reserved
    // until acceptance and let an error take precedence over an idle event.
    if (capture.task.state === "submitting") {
      if (capture.terminal !== "failed") capture.terminal = state;
      return;
    }
    this.release(sessionID);
    const task = capture.task;
    if (state === "failed" && !this.disposing && task.attempts < MAX_ATTEMPTS) {
      task.state = "queued";
      log("retrying failed capture", task.parent, task.snapshot.turnId);
      this.schedule(() => this.submit(task));
    } else {
      this.remember(task, state);
      if (state === "failed")
        log("capture failed; no further attempts", task.parent, task.snapshot.turnId);
    }
  };

  drain = async (timeoutMs = 10_000): Promise<boolean> => {
    const pending = [...this.activeCaptures.values()].map((capture) => capture.done);
    if (pending.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([Promise.all(pending).then(() => true as const), timedOut]);
    if (timer) clearTimeout(timer);
    if (!result) log("capture drain timed out");
    return result;
  };

  private schedule(work: () => Promise<void>): void {
    this.submissions = this.submissions.then(work).catch((e: unknown) => {
      log("dispatchCapture failed", e);
    });
  }

  private async submit(task: CaptureTask): Promise<void> {
    try {
      // A retry must not move an old transcript into a newly selected branch.
      if (task.attempts > 0 && (await this.options.currentBranch()) !== task.branch) {
        log("capture retry cancelled: project branch changed", task.parent);
        this.remember(task, "failed");
        return;
      }
      const client = await this.options.connectClient();
      if (client) {
        if (!(await this.options.matchBranch(client, this.drain))) {
          this.tasks.delete(task.key);
          log("capture deferred: memoir branch could not be confirmed", task.parent);
          return;
        }
      } else if (await this.options.currentBranch()) {
        this.tasks.delete(task.key);
        log("capture deferred: memoir client unavailable", task.parent);
        return;
      }
      const branch = await this.options.currentBranch();
      // Matching can wait for active captures; recheck the project after that
      // wait so an old retry cannot be submitted on a newly selected branch.
      if (task.attempts > 0 && branch !== task.branch) {
        this.remember(task, "failed");
        log("capture retry cancelled: project branch changed during matching", task.parent);
        return;
      }
      task.branch ??= branch;
      task.state = "submitting";
      task.attempts++;
      const id = await runMemoirSubagent(
        this.sdkClient,
        task.parent,
        task.snapshot.transcript ?? "",
        this.options.model(),
        (sessionID) => {
          let resolve!: () => void;
          const done = new Promise<void>((complete) => {
            resolve = complete;
          });
          this.activeCaptures.set(sessionID, { task, done, resolve });
          // Submission rejection is distinct from a background session error.
          return () => {
            this.release(sessionID);
          };
        },
      );
      task.state = "accepted";
      const terminal = this.activeCaptures.get(id)?.terminal;
      if (terminal) this.finish(id, terminal);
    } catch (e) {
      task.state = "failed";
      this.tasks.delete(task.key);
      throw e;
    }
  }

  enqueue = (parent: string): void => {
    if (!this.sdkClient || this.disposing) return;
    // Read immediately, even when an earlier submission is still queued.
    const snapshot = prepareCaptureTurn(this.sdkClient, parent).catch((e: unknown) => {
      log("capture snapshot failed", e);
      return null;
    });
    this.schedule(async () => {
      const prepared = await snapshot;
      if (!prepared) return;
      const key = JSON.stringify([parent, prepared.turnId]);
      if (this.tasks.has(key) || this.recent.has(key)) return;
      const task: CaptureTask = { key, parent, snapshot: prepared, state: "queued", attempts: 0 };
      if (prepared.transcript === null) {
        this.remember(task, "completed");
        return;
      }
      this.tasks.set(key, task);
      await this.submit(task);
    });
  };

  async close(): Promise<void> {
    this.disposing = true;
    await this.submissions;
    await this.drain();
    this.tasks.clear();
    this.recent.clear();
  }
}
