/**
 * Parsed shape of the `memoir_status` tool response.
 *
 * The branch matcher (store.ts) reads this payload, so the parse lives here
 * once instead of being duplicated across callers.
 */
export type MemoirStatus = {
  branch?: string;
  memory_count?: number;
};

/**
 * Decode a `memoir_status` text payload into a typed, sanitized object.
 * Returns an empty object on a missing or malformed payload so callers can
 * treat every field as optional without guarding parse errors themselves.
 */
export function parseMemoirStatus(raw: string | null | undefined): MemoirStatus {
  if (!raw) return {};
  try {
    const status = JSON.parse(raw) as MemoirStatus;
    return {
      branch: typeof status.branch === "string" ? status.branch : undefined,
      memory_count: typeof status.memory_count === "number" ? status.memory_count : undefined,
    };
  } catch {
    return {};
  }
}
