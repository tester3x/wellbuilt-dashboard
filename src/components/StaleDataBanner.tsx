'use client';

import type { WellPoolHealth } from '@/lib/wellEstimation';
import { describePoolHealth } from '@/lib/wellEstimation';

/**
 * Says out loud when the well pool is no longer being confirmed against the
 * server.
 *
 * The levels on screen keep advancing from the last good snapshot even while
 * degraded, which is useful but dangerous unannounced — a forecast that looks
 * identical to live data is how a stale screen gets trusted. This banner is the
 * difference between "estimating from 9:05" and "current".
 */
export function StaleDataBanner({ health }: { health: WellPoolHealth | null }) {
  const notice = describePoolHealth(health);
  if (!notice) return null;

  const tone = notice.severity === 'error'
    ? 'bg-red-950/60 border-red-700 text-red-200'
    : 'bg-amber-950/60 border-amber-700 text-amber-200';

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="stale-data-banner"
      className={`mb-3 rounded border px-3 py-2 text-sm ${tone}`}
    >
      <span className="font-semibold">{notice.title}</span>
      <span className="ml-2 opacity-90">{notice.detail}</span>
    </div>
  );
}
