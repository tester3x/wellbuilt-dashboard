'use client';

import { useEffect, useState } from 'react';

/**
 * One shared wall-clock ticker for a page. Returns `asOfMs`, updated every
 * `intervalMs` (default 30s) so time-based projections (the WB‑M current-level
 * estimate) advance without a new server packet. A single hook call drives an
 * entire list — pass the returned `asOfMs` to each row's projection rather than
 * running a timer per row.
 *
 * Recomputes IMMEDIATELY when the page/tab returns to the foreground
 * (visibilitychange → visible) or regains focus, so a backgrounded page catches
 * up at once. All listeners + the interval are torn down deterministically on
 * unmount (no per-row timer/subscription leaks).
 */
export function useSharedNow(intervalMs = 30000): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, intervalMs);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', tick);
    // Catch up immediately on mount (covers a resume that predates the first tick).
    tick();
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', tick);
    };
  }, [intervalMs]);

  return now;
}
