export function buildTurnStatus(statusRaw: string | null): string {
  let branch = "";
  let memoryCount = 0;
  try {
    const status = JSON.parse(statusRaw ?? "") as { branch?: unknown; memory_count?: unknown };
    if (typeof status.branch === "string") branch = status.branch;
    if (typeof status.memory_count === "number") memoryCount = status.memory_count;
  } catch {
    return "";
  }
  if (!branch && memoryCount <= 0) return "";
  if (!branch) return `[memoir] memory available (${memoryCount} memories)`;
  return `[memoir] ${branch}${memoryCount > 0 ? ` · memory available (${memoryCount} memories)` : ""}`;
}
