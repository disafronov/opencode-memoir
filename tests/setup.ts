import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect plugin logging away from the real on-disk log during tests.
// Without this, debug.log() falls back to $XDG_STATE_HOME/opencode/
// memoir-plugin-*.log and every test process that triggers a log() call
// (capture, index, store, mcp-client, ...) pollutes the real plugin log.
const dir = mkdtempSync(join(tmpdir(), "memoir-test-log-"));
process.env.MEMOIR_LOG = join(dir, "plugin.log");

process.on("exit", () => {
  rmSync(dir, { recursive: true, force: true });
});
