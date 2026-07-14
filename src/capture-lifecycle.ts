import { log } from "./debug.js";

type ActiveCapture = {
  done: Promise<void>;
  resolve: () => void;
  childSessionID?: string;
};

/** Track actual memoir task execution, including native background jobs. */
export class CaptureLifecycle {
  private readonly active = new Map<string, ActiveCapture>();
  private readonly callsByChild = new Map<string, string>();

  begin(callID: string): void {
    if (this.active.has(callID)) return;
    let resolve!: () => void;
    const done = new Promise<void>((doneResolve) => {
      resolve = doneResolve;
    });
    this.active.set(callID, { done, resolve });
  }

  background(callID: string, childSessionID: string): void {
    const capture = this.active.get(callID);
    if (!capture) return;
    capture.childSessionID = childSessionID;
    this.callsByChild.set(childSessionID, callID);
  }

  finishCall(callID: string): void {
    const capture = this.active.get(callID);
    if (!capture) return;
    if (capture.childSessionID) this.callsByChild.delete(capture.childSessionID);
    this.active.delete(callID);
    capture.resolve();
  }

  finishSession(sessionID: string): void {
    const callID = this.callsByChild.get(sessionID);
    if (callID) this.finishCall(callID);
  }

  async drain(timeoutMs = 10_000): Promise<boolean> {
    const pending = [...this.active.values()].map((capture) => capture.done);
    if (pending.length === 0) return true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const drained = Promise.all(pending).then(() => true as const);
    const result = await Promise.race([drained, timedOut]);
    if (timer) clearTimeout(timer);
    if (!result) log("capture lifecycle: drain timed out; branch switch deferred");
    return result;
  }

  clear(): void {
    for (const callID of [...this.active.keys()]) this.finishCall(callID);
  }
}
