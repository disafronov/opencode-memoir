/** Per-session message count for periodic reminders. */
export const sessionMsgCount = new Map<string, number>();

const REMINDER_INTERVAL = Math.max(0, parseInt(process.env.MEMOIR_REMINDER_INTERVAL ?? "5", 10));

export function incrementMsgCount(sessionID: string): number {
  const count = (sessionMsgCount.get(sessionID) ?? 0) + 1;
  sessionMsgCount.set(sessionID, count);
  return count;
}

export function shouldRemind(count: number): boolean {
  return REMINDER_INTERVAL > 0 && count > 1 && count % REMINDER_INTERVAL === 0;
}

export function pruneAll(): void {
  sessionMsgCount.clear();
}
