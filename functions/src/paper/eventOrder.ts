export function comparePaperEvents(
  a: { eventMs: number; sourceEventId: string },
  b: { eventMs: number; sourceEventId: string },
): number {
  if (a.eventMs !== b.eventMs) return a.eventMs - b.eventMs;
  if (a.sourceEventId === b.sourceEventId) return 0;
  return a.sourceEventId < b.sourceEventId ? -1 : 1;
}

export function eventIsNewerThanCurrent(
  candidate: { eventMs: number; sourceEventId: string },
  current: { eventMs: number; sourceEventId: string } | null,
): boolean {
  if (!current || !current.sourceEventId) return true;
  return comparePaperEvents(candidate, current) > 0;
}
