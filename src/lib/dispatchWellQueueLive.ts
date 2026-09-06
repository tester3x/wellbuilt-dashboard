/**
 * Dispatch well-queue live-status attach policy.
 * RTDB well_config / packets/outgoing require auth != null. Subscribing
 * before Auth has minted an ID token produces intermittent permission-denied.
 */

export type WellQueueLiveAuth = {
  loading: boolean;
  uid: string | null | undefined;
  companyId?: string | null;
};

export type WellQueueLiveGate = 'wait' | 'skip' | 'subscribe';

export function wellQueueLiveGate(auth: WellQueueLiveAuth): WellQueueLiveGate {
  if (auth.loading) return 'wait';
  if (!auth.uid) return 'wait';
  if (auth.companyId && auth.companyId !== 'liquid-gold') return 'skip';
  return 'subscribe';
}

export function wellQueueLiveGenerationApplies(eventGen: number, activeGen: number): boolean {
  return Number.isInteger(eventGen) && eventGen === activeGen && eventGen > 0;
}

/** Stale error must not replace a newer live success. */
export function nextWellsErrorAfterEvent(args: {
  eventGen: number;
  activeGen: number;
  event: 'success' | 'error';
  previous: string | undefined;
  nextError?: string;
}): string | undefined {
  if (!wellQueueLiveGenerationApplies(args.eventGen, args.activeGen)) return args.previous;
  if (args.event === 'success') return undefined;
  return args.nextError;
}


