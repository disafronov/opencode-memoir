import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { dispatchCaptureSnapshot, prepareCaptureTurn } from "./capture.js";
import { log } from "./debug.js";

type CaptureCoordinatorOptions = {
  connectClient: () => Promise<Client | null>;
  matchBranch: (client: Client, drain: () => Promise<boolean>) => Promise<boolean>;
  currentBranch: () => Promise<string>;
  model: () => string | undefined;
};

/** Owns capture queues and hidden-session lifecycle for one plugin instance. */
export class CaptureCoordinator {
  private readonly lastCaptured = new Map<string, string>();
  private readonly captureQueues = new Map<string, Promise<void>>();
  private readonly activeCaptures = new Map<string, { done: Promise<void>; resolve: () => void }>();
  private disposing = false;

  constructor(
    private readonly sdkClient: unknown,
    private readonly options: CaptureCoordinatorOptions,
  ) {}

  private trackCapture = (sessionID: string): (() => void) | undefined => {
    if (this.activeCaptures.has(sessionID)) return undefined;
    let resolve!: () => void;
    const done = new Promise<void>((doneResolve) => {
      resolve = doneResolve;
    });
    this.activeCaptures.set(sessionID, { done, resolve });
    return () => this.finish(sessionID);
  };

  finish = (sessionID: string): void => {
    const capture = this.activeCaptures.get(sessionID);
    if (!capture) return;
    this.activeCaptures.delete(sessionID);
    capture.resolve();

    const sessionApi = (
      this.sdkClient as
        | { session?: { delete?: (input: { path: { id: string } }) => Promise<unknown> } }
        | null
        | undefined
    )?.session;
    if (sessionApi?.delete) {
      void sessionApi.delete({ path: { id: sessionID } }).catch((e: unknown) => {
        log("failed to delete completed capture session", sessionID, e);
      });
    }
  };

  drain = async (timeoutMs = 10_000): Promise<boolean> => {
    const pending = [...this.activeCaptures.values()].map((capture) => capture.done);
    if (pending.length === 0) return true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const drained = Promise.all(pending).then(() => true as const);
    const result = await Promise.race([drained, timedOut]);
    if (timer) clearTimeout(timer);
    if (!result) log("capture drain timed out");
    return result;
  };

  enqueue = (sid: string): void => {
    if (!this.sdkClient || this.disposing) return;

    // Start transcript retrieval immediately so every chat.message snapshots
    // its own completed turn even while an earlier dispatch is still pending.
    const snapshot = prepareCaptureTurn(this.sdkClient, sid).catch((e: unknown) => {
      log("capture snapshot failed", e);
      return null;
    });
    const previous = this.captureQueues.get(sid) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const prepared = await snapshot;
        if (!prepared) return;

        const client = await this.options.connectClient();
        if (client) {
          if (!(await this.options.matchBranch(client, this.drain))) {
            log("capture deferred: memoir branch could not be confirmed", sid);
            return;
          }
        } else if (await this.options.currentBranch()) {
          log("capture deferred: memoir client unavailable", sid);
          return;
        }
        await dispatchCaptureSnapshot(
          this.sdkClient,
          sid,
          prepared,
          this.lastCaptured,
          this.options.model(),
          this.trackCapture,
        );
      })
      .catch((e: unknown) => {
        log("dispatchCapture failed", e);
      });

    this.captureQueues.set(sid, current);
    void current.then(() => {
      if (this.captureQueues.get(sid) === current) this.captureQueues.delete(sid);
    });
  };

  async close(): Promise<void> {
    this.disposing = true;
    await Promise.all([...this.captureQueues.values()]);
    await this.drain();
    this.captureQueues.clear();
    this.lastCaptured.clear();
  }
}
