/**
 * Dispatch well-queue live-status attach policy.
 * Live RTDB well_config has no parent .read — catalog is the authorized
 * source. packets/outgoing parent read is wellbuiltAdmin &&
 * platformAdminEnabled only. Do not parent-listen well_config.
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
/** Live RTDB packets/outgoing parent read is claim-gated. well_config parent has no .read. */
export function canListenPacketsOutgoingParent(claims: unknown): boolean {
  if (!claims || typeof claims !== 'object') return false;
  const c = claims as Record<string, unknown>;
  return c.wellbuiltAdmin === true && c.platformAdminEnabled === true;
}

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


