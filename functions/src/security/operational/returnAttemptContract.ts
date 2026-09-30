/** Contract shared by the two narrow return-drive endpoints. No caller identity fields. */
export const RETURN_ATTEMPT_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;
export type ReturnEventType = 'depart_return' | 'return_abandoned';

export function parseReturnAttempt(data: unknown, type: ReturnEventType): { attemptId?: string } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('payload_not_object');
  const d = data as Record<string, unknown>;
  const extra = Object.keys(d).filter(k => !['periodId', 'attemptId'].includes(k));
  if (extra.length) throw new Error(`unknown_fields:${extra.join(',')}`);
  if (d.attemptId === undefined && type === 'depart_return') return {}; // older Suite
  if (typeof d.attemptId !== 'string' || !RETURN_ATTEMPT_ID_RE.test(d.attemptId)) throw new Error('malformed_attempt');
  return { attemptId: d.attemptId };
}

export function returnAttemptState(events: unknown[], periodId: string, attemptId?: string) {
  const matching = events.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e))
    .filter(e => e.shiftId === periodId && (attemptId === undefined || e.attemptId === attemptId));
  return {
    departed: matching.some(e => e.type === 'depart_return'),
    abandoned: matching.some(e => e.type === 'return_abandoned'),
  };
}
