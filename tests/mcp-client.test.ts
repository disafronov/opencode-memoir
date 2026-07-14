import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { MemoirRuntime } from "../src/mcp-client.ts";

const fixture = fileURLToPath(new URL("fixtures/fake-mcp.mjs", import.meta.url));

describe("MemoirRuntime", () => {
  it("owns server state per plugin instance", async () => {
    const first = new MemoirRuntime([process.execPath, fixture]);
    const second = new MemoirRuntime([process.execPath, fixture]);

    assert.notStrictEqual(first, second);
    const firstUrl = await first.start();
    const secondUrl = await second.start();
    assert.match(firstUrl.toString(), /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.match(secondUrl.toString(), /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    await first.close();
    await second.close();
  });

  it("can be started again after close", async () => {
    const runtime = new MemoirRuntime([process.execPath, fixture]);
    const first = await runtime.start();
    await runtime.close();
    const second = await runtime.start();
    assert.match(first.toString(), /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.match(second.toString(), /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    await runtime.close();
  });

  it("starts and stops a real child process and shares concurrent starts", async () => {
    const runtime = new MemoirRuntime([process.execPath, fixture]);
    try {
      const [first, second] = await Promise.all([runtime.start(), runtime.start()]);
      assert.strictEqual(first.toString(), second.toString());
      assert.match(first.toString(), /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

      await runtime.close();
      const restarted = await runtime.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(restarted.toString(), first.toString());
      assert.strictEqual((await runtime.start()).toString(), restarted.toString());
    } finally {
      await runtime.close();
    }
  });

  it("reports spawn failures and remains restartable", async () => {
    const runtime = new MemoirRuntime([`missing-memoir-command-${process.pid}`]);
    await assert.rejects(runtime.start(), /failed to spawn/);
    await assert.rejects(runtime.start(), /failed to spawn/);
    await runtime.close();
  });

  it("shares connections, resets on transport close, and closes the client", async () => {
    let created = 0;
    let connected = 0;
    let closed = 0;
    let transportClose: (() => void) | undefined;
    const runtime = new MemoirRuntime([process.execPath, fixture], undefined, undefined, {
      createClientConnection: () => {
        created++;
        const transport = {
          set onclose(value: (() => void) | undefined) {
            transportClose = value;
          },
        };
        const client = {
          connect: async () => {
            connected++;
          },
          close: async () => {
            closed++;
          },
        };
        return { client, transport } as never;
      },
    });

    const [first, second] = await Promise.all([runtime.connect(), runtime.connect()]);
    assert.strictEqual(first, second);
    assert.strictEqual(created, 1);
    assert.strictEqual(connected, 1);

    transportClose?.();
    const third = await runtime.connect();
    assert.notStrictEqual(third, first);
    assert.strictEqual(created, 2);
    await runtime.close();
    assert.strictEqual(closed, 1);
  });

  it("retries after a client connection failure and tolerates close failures", async () => {
    let attempts = 0;
    const runtime = new MemoirRuntime([process.execPath, fixture], undefined, undefined, {
      createClientConnection: () => {
        const client = {
          connect: async () => {
            attempts++;
            if (attempts === 1) throw new Error("connect failed");
          },
          close: async () => {
            throw "close failed";
          },
        };
        return { client, transport: {} } as never;
      },
    });
    await assert.rejects(runtime.connect(), /connect failed/);
    await runtime.connect();
    await runtime.close();
    assert.strictEqual(attempts, 2);
  });

  it("discovers and caches the live tool catalog per connection", async () => {
    let calls = 0;
    const client = {
      listTools: async () => {
        calls++;
        return {
          tools: [
            { name: "memoir_remember", description: "store" },
            { name: "memoir_get", description: 42 },
          ],
        };
      },
    };
    const runtime = new MemoirRuntime([process.execPath, fixture]);
    const first = await runtime.listTools(client as never);
    const second = await runtime.listTools(client as never);
    assert.deepStrictEqual(first, [
      { name: "memoir_memoir_remember", description: "store" },
      { name: "memoir_memoir_get", description: "" },
    ]);
    assert.strictEqual(second, first);
    assert.strictEqual(calls, 1);
  });

  it("returns an empty catalog when discovery fails", async () => {
    const runtime = new MemoirRuntime([process.execPath, fixture]);
    const client = {
      listTools: async () => {
        throw "catalog failed";
      },
    };
    assert.deepStrictEqual(await runtime.listTools(client as never), []);
  });
});
