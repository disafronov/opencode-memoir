import { tool } from "@opencode-ai/plugin";
import { ensureStoreOrError, statusJson } from "./memoir-ops.js";
import { DEFAULT_RECALL_NAMESPACES, isSecretSanitizationEnabled } from "./recall-gate.js";
import { deriveStorePath, runMemoir } from "./store.js";
import { coercePaths, MEMOIR_GET_MAX_KEYS, SECRET_PATTERN, tryPrettyJson } from "./utils.js";

type MemoirRememberArgs = {
  content: string;
  path?: string | string[];
  namespace?: string;
  replace?: boolean;
};

type MemoirRecallArgs = {
  query?: string;
  namespace?: string;
  namespaces?: string[];
  includeMetrics?: boolean;
};

type MemoirGetArgs = {
  keys: string[];
  namespace?: string;
};

const memoirStatus = tool({
  description: "Show Memoir status for the current OpenCode project store.",
  args: {},
  execute: async () => statusJson(deriveStorePath()),
});

const memoirRemember = tool({
  description: "Explicitly save a durable memory to Memoir at one or more semantic taxonomy paths.",
  args: {
    content: tool.schema.string().describe("Memory content to save. Do not include secrets."),
    path: tool.schema
      .string()
      .optional()
      .describe("Semantic taxonomy path, e.g. preferences.coding.style."),
    namespace: tool.schema.string().optional().describe("Memoir namespace. Defaults to default."),
    replace: tool.schema.boolean().optional().describe("Replace existing value at the path."),
  },
  execute: async (args: MemoirRememberArgs) => {
    const content = args.content?.trim();
    if (!content) return "Memoir memory was not saved: content is empty.";
    if (isSecretSanitizationEnabled() && SECRET_PATTERN.test(content)) {
      return "Memoir memory was not saved: the content looks like a secret or credential. Save a redacted rule instead.";
    }
    const paths = coercePaths(args.path);
    if (paths.length === 0) {
      return "Memoir memory was not saved: provide a semantic path, e.g. preferences.coding.style.";
    }

    const store = deriveStorePath();
    const storeError = await ensureStoreOrError(store);
    if (storeError) return storeError;

    const cliArgs = ["--json", "-s", store, "remember", content];
    for (const p of paths) cliArgs.push("-p", p);
    cliArgs.push("-n", args.namespace ?? "default");
    if (args.replace) cliArgs.push("--replace");
    const rememberResult = await runMemoir(cliArgs, { cwd: store });
    if (!rememberResult.ok) return rememberResult.error;
    return tryPrettyJson(rememberResult.stdout);
  },
});

const memoirRecall = tool({
  description:
    "List Memoir memory keys across relevant namespaces for relevance picking. Never calls legacy memoir recall.",
  args: {
    query: tool.schema.string().optional().describe("User query or topic to recall for."),
    namespace: tool.schema
      .string()
      .optional()
      .describe(
        "Single Memoir namespace to inspect. If omitted, checks default + onboard namespaces.",
      ),
    namespaces: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Namespaces to inspect. Defaults to default, project:onboard, codebase:onboard."),
    includeMetrics: tool.schema
      .boolean()
      .optional()
      .describe("Include metrics.* memories in the listing."),
  },
  execute: async (args: MemoirRecallArgs) => {
    const store = deriveStorePath();
    const storeError = await ensureStoreOrError(store);
    if (storeError) return storeError;

    const namespaces = args.namespace
      ? [args.namespace]
      : args.namespaces && args.namespaces.length > 0
        ? args.namespaces
        : DEFAULT_RECALL_NAMESPACES;
    const sections: string[] = [];
    for (const namespace of namespaces) {
      const summarizeResult = await runMemoir(
        ["--json", "-s", store, "summarize", "--depth", "3", "-n", namespace],
        { cwd: store },
      );
      if (!summarizeResult.ok) return summarizeResult.error;
      const output = tryPrettyJson(summarizeResult.stdout);
      sections.push(`## namespace: ${namespace}\n${output}`);
    }
    const note = args.includeMetrics
      ? "Metrics were included by request."
      : "Ignore metrics.* and taxonomy:v1:* entries unless explicitly needed. If default is empty or only metrics, inspect project:onboard/codebase:onboard before concluding there is no memory.";
    const query = args.query ? `Query: ${args.query}\n` : "";
    return `${query}${note}\nPick at most 5-7 relevant exact keys across namespaces, then call memoir_get with the matching namespace if values are needed.\n${sections.join("\n\n")}`;
  },
});

const memoirGet = tool({
  description: "Fetch exact Memoir memory keys after selecting them from memoir_recall output.",
  args: {
    keys: tool.schema.array(tool.schema.string()).describe("Exact memory keys to fetch."),
    namespace: tool.schema.string().optional().describe("Memoir namespace. Defaults to default."),
  },
  execute: async (args: MemoirGetArgs) => {
    const keys = args.keys?.map((key) => key.trim()).filter(Boolean) ?? [];
    if (keys.length === 0) return "No Memoir keys were provided.";
    if (keys.length > MEMOIR_GET_MAX_KEYS) {
      return `Error: Too many keys requested (max ${MEMOIR_GET_MAX_KEYS}, got ${keys.length}). Narrow your selection from memoir_recall output.`;
    }

    const store = deriveStorePath();
    const storeError = await ensureStoreOrError(store);
    if (storeError) return storeError;

    const getResult = await runMemoir(
      ["--json", "-s", store, "get", ...keys, "-n", args.namespace ?? "default"],
      { cwd: store },
    );
    if (!getResult.ok) return getResult.error;
    return tryPrettyJson(getResult.stdout);
  },
});

export const memoirTools = {
  memoir_status: memoirStatus,
  memoir_remember: memoirRemember,
  memoir_recall: memoirRecall,
  memoir_get: memoirGet,
};
