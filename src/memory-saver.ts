const REMINDER_INTERVAL = Math.max(0, parseInt(process.env.MEMOIR_REMINDER_INTERVAL ?? "5", 10));

export function shouldRemind(count: number): boolean {
  return REMINDER_INTERVAL > 0 && count > 1 && count % REMINDER_INTERVAL === 0;
}

/** Message counters owned by one plugin instance. */
export class MemorySaver {
  readonly counts = new Map<string, number>();

  increment(sessionID: string): number {
    const count = (this.counts.get(sessionID) ?? 0) + 1;
    this.counts.set(sessionID, count);
    return count;
  }

  get(sessionID: string): number {
    return this.counts.get(sessionID) ?? 0;
  }

  clear(): void {
    this.counts.clear();
  }
}
