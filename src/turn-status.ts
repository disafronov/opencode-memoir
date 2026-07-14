import { parseMemoirStatus } from "./status.js";

export function buildTurnStatus(statusRaw: string | null): string {
  const { branch, memory_count } = parseMemoirStatus(statusRaw);
  const memoryCount = memory_count ?? 0;
  if (!branch && memoryCount <= 0) return "";
  if (!branch) return `[memoir] memory available (${memoryCount} memories)`;
  return `[memoir] ${branch}${memoryCount > 0 ? ` · memory available (${memoryCount} memories)` : ""}`;
}
