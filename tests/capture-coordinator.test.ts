import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CaptureCoordinator } from "../src/capture-coordinator.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function messages(parent: string) {
  return {
    data: [
      {
        info: { id: `user-${parent}`, role: "user" },
        parts: [{ type: "text", text: "Remember this durable project decision" }],
      },
      {
        info: { id: `turn-${parent}`, role: "assistant" },
        parts: [{ type: "text", text: "The project decision is confirmed" }],
      },
    ],
  };
}

const options = {
  connectClient: async () => ({}) as never,
  matchBranch: async () => true,
  currentBranch: async () => "",
  model: () => undefined,
};

describe("CaptureCoordinator", () => {
  it("holds branch ownership until registration and drains the first parent before switching", {
    timeout: 2_000,
  }, async () => {
    const creatingFirst = deferred();
    const releaseCreate = deferred();
    const drainingFirst = deferred();
    const submittedSecond = deferred();
    let codeBranch = "first";
    let storeBranch = "first";
    let checks = 0;
    let created = 0;
    const snapshots: string[] = [];
    const prompts: string[] = [];
    const coordinator = new CaptureCoordinator(
      {
        session: {
          messages: async ({ path }: { path: { id: string } }) => {
            snapshots.push(path.id);
            return messages(path.id);
          },
          create: async () => {
            const id = `capture-${++created}`;
            if (created === 1) {
              creatingFirst.resolve();
              await releaseCreate.promise;
            }
            return { data: { id } };
          },
          promptAsync: async ({ path }: { path: { id: string } }) => {
            prompts.push(path.id);
            if (prompts.length === 2) submittedSecond.resolve();
          },
        },
      },
      {
        ...options,
        matchBranch: async (_client, drain) => {
          checks++;
          if (storeBranch !== codeBranch) {
            drainingFirst.resolve();
            if (!(await drain())) return false;
            storeBranch = codeBranch;
          }
          return true;
        },
      },
    );

    coordinator.enqueue("parent-first");
    await creatingFirst.promise;
    codeBranch = "second";
    coordinator.enqueue("parent-second");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(snapshots, ["parent-first", "parent-second"]);
    assert.strictEqual(checks, 1);
    assert.strictEqual(storeBranch, "first");
    releaseCreate.resolve();
    await drainingFirst.promise;
    assert.deepEqual(prompts, ["capture-1"]);
    assert.strictEqual(storeBranch, "first");
    coordinator.finish("capture-1");
    await submittedSecond.promise;
    assert.strictEqual(storeBranch, "second");
    coordinator.finish("capture-2");
    await coordinator.close();
  });

  it("allows accepted captures on the same branch to remain active together", {
    timeout: 2_000,
  }, async () => {
    const submitted = deferred();
    const deleted: string[] = [];
    let created = 0;
    let prompts = 0;
    const coordinator = new CaptureCoordinator(
      {
        session: {
          messages: async ({ path }: { path: { id: string } }) => messages(path.id),
          create: async () => ({ data: { id: `capture-${++created}` } }),
          promptAsync: async () => {
            if (++prompts === 2) submitted.resolve();
          },
          delete: async ({ path }: { path: { id: string } }) => {
            deleted.push(path.id);
          },
        },
      },
      options,
    );
    coordinator.enqueue("first");
    coordinator.enqueue("second");
    await submitted.promise;
    assert.strictEqual(await coordinator.drain(1), false);
    coordinator.finish("capture-1");
    coordinator.finish("capture-1");
    coordinator.finish("unrelated");
    assert.strictEqual(await coordinator.drain(1), false);
    coordinator.finish("capture-2");
    assert.strictEqual(await coordinator.drain(1), true);
    assert.deepEqual(deleted, ["capture-1", "capture-2"]);
    await coordinator.close();
  });

  it("recovers the submission queue after an error and retries the same turn", {
    timeout: 2_000,
  }, async () => {
    const failed = deferred();
    const deleted: string[] = [];
    let created = 0;
    let prompts = 0;
    const coordinator = new CaptureCoordinator(
      {
        session: {
          messages: async ({ path }: { path: { id: string } }) => messages(path.id),
          create: async () => ({ data: { id: `capture-${++created}` } }),
          promptAsync: async ({ path }: { path: { id: string } }) => {
            if (++prompts === 1) return { error: { message: "submission failed" } };
            coordinator.finish(path.id);
            return {};
          },
          delete: async ({ path }: { path: { id: string } }) => {
            deleted.push(path.id);
            if (path.id === "capture-1") failed.resolve();
          },
        },
      },
      options,
    );
    coordinator.enqueue("first");
    await failed.promise;
    coordinator.enqueue("second");
    coordinator.enqueue("first");
    await coordinator.close();
    assert.strictEqual(prompts, 3);
    assert.deepEqual(deleted, ["capture-1", "capture-2", "capture-3"]);
  });

  it("stops accepting work during shutdown and waits for queued and active captures", {
    timeout: 2_000,
  }, async () => {
    const reading = deferred();
    const releaseRead = deferred();
    const submitted = deferred();
    let reads = 0;
    const coordinator = new CaptureCoordinator(
      {
        session: {
          messages: async () => {
            reads++;
            reading.resolve();
            await releaseRead.promise;
            return messages("parent");
          },
          create: async () => ({ data: { id: "capture" } }),
          promptAsync: async () => {
            submitted.resolve();
          },
        },
      },
      options,
    );
    coordinator.enqueue("parent");
    await reading.promise;
    let closed = false;
    const closing = coordinator.close().then(() => {
      closed = true;
    });
    coordinator.enqueue("ignored");
    assert.strictEqual(reads, 1);
    assert.strictEqual(closed, false);
    releaseRead.resolve();
    await submitted.promise;
    assert.strictEqual(closed, false);
    coordinator.finish("capture");
    await closing;
    coordinator.enqueue("still-ignored");
    assert.strictEqual(reads, 1);
    assert.strictEqual(closed, true);
  });
});
