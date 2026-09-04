export const PENDING_REGISTRATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type PendingTerminalStatus = 'approved' | 'rejected' | 'cancelled' | 'expired';

export function pendingExpiresAtMs(record: Record<string, unknown>, nowMs: number): number {
  const explicit = Number(record.expiresAtMs);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const requested = Number(record.requestedAt);
  if (Number.isFinite(requested) && requested > 0) return requested + PENDING_REGISTRATION_TTL_MS;
  // Pre-fix rows without a usable server timestamp fail closed immediately.
  return nowMs;
}

export function isPendingExpired(record: Record<string, unknown>, nowMs: number): boolean {
  return (record.status || 'pending') === 'pending' && pendingExpiresAtMs(record, nowMs) <= nowMs;
}

export function pollStatusFor(record: Record<string, unknown>, nowMs: number): 'pending' | 'approved' | 'rejected' {
  if (isPendingExpired(record, nowMs) || record.status === 'expired' || record.status === 'cancelled') return 'rejected';
  if (record.status === 'approved') return 'approved';
  if (record.status === 'rejected') return 'rejected';
  return 'pending';
}

export function pendingReservationId(nameNorm: string): string {
  // Product identity is globally unique by normalized display name today.
  return `registration:${nameNorm}`;
}

export function reservationIsActive(record: Record<string, unknown> | undefined, nowMs: number): boolean {
  if (!record || record.status !== 'pending') return false;
  const expiresAtMs = Number(record.expiresAtMs);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs && typeof record.pendingId === 'string';
}
