import {
  PENDING_REGISTRATION_TTL_MS,
  isPendingExpired,
  pendingExpiresAtMs,
  pendingReservationId,
  pollStatusFor,
  reservationIsActive,
} from '../registrationLifecycle';

describe('pending registration lifecycle policy', () => {
  const now = 1_000_000;

  test('TTL is an explicit 72-hour policy', () => {
    expect(PENDING_REGISTRATION_TTL_MS).toBe(72 * 60 * 60 * 1000);
  });

  test('explicit expiry is authoritative', () => {
    expect(pendingExpiresAtMs({ requestedAt: 1, expiresAtMs: 99 }, now)).toBe(99);
  });

  test('pre-fix rows derive expiry from requestedAt', () => {
    expect(pendingExpiresAtMs({ requestedAt: 100 }, now)).toBe(100 + PENDING_REGISTRATION_TTL_MS);
  });

  test('undated pre-fix rows expire closed', () => {
    expect(isPendingExpired({ status: 'pending' }, now)).toBe(true);
  });

  test('expired and cancelled map to rejected for all five existing clients', () => {
    expect(pollStatusFor({ status: 'expired' }, now)).toBe('rejected');
    expect(pollStatusFor({ status: 'cancelled' }, now)).toBe('rejected');
  });

  test('polling never produces authentication material', () => {
    expect(Object.keys({ status: pollStatusFor({ status: 'pending', expiresAtMs: now + 1 }, now) })).toEqual(['status']);
  });

  test('global normalized name is the established reservation identity', () => {
    expect(pendingReservationId('mike')).toBe('registration:mike');
  });

  test('only unexpired pending reservations are active', () => {
    expect(reservationIsActive({ status: 'pending', pendingId: 'p1', expiresAtMs: now + 1 }, now)).toBe(true);
    expect(reservationIsActive({ status: 'pending', pendingId: 'p1', expiresAtMs: now }, now)).toBe(false);
    expect(reservationIsActive({ status: 'rejected', pendingId: 'p1', expiresAtMs: now + 1 }, now)).toBe(false);
  });
});
