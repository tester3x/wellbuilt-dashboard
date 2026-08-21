/**
 * Atomic fixed-window rate limiter.
 * Concurrent callers share one counter; the N+1th request in a window is denied.
 */
export interface RateWindow {
  windowStart: number;
  count: number;
}

export function incrementRateWindow(
  current: RateWindow | null,
  nowMs: number,
  windowMs: number,
): RateWindow {
  if (!current || !current.windowStart || nowMs - current.windowStart > windowMs) {
    return { windowStart: nowMs, count: 1 };
  }
  return { windowStart: current.windowStart, count: (current.count || 0) + 1 };
}

export function nextRateWindow(
  current: RateWindow | null,
  nowMs: number,
  windowMs: number,
  limit: number,
): { allowed: boolean; next: RateWindow } {
  const next = incrementRateWindow(current, nowMs, windowMs);
  return { allowed: next.count <= limit, next };
}
