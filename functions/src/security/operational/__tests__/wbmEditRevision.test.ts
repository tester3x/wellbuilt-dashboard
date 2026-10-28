import { preserveOriginalGaugePrecision, verifiedEditRecovery, wbmEditRevisionKey } from '../wbmEditRevision';

it('deduplicates a retry but separates changed corrections without changing the parent pull', () => {
  const body = { originalPacketId: 'pull', tankLevelFeet: 9, bblsTaken: 80, idempotencyKey: 'edit' };
  expect(wbmEditRevisionKey('edit', body)).toBe(wbmEditRevisionKey('edit', { ...body }));
  expect(wbmEditRevisionKey('edit', body)).not.toBe(wbmEditRevisionKey('edit', { ...body, tankLevelFeet: 9 + 8 / 12 }));
  expect(body.originalPacketId).toBe('pull');
});

it('preserves original milliseconds when packet-ID parsing truncated them, without suppressing a real time correction', () => {
  const original = { dateTimeUTC: '2026-10-27T19:18:38.065Z' };
  const body = { dateTimeUTC: '2026-10-27T19:18:38.000Z' };
  expect(preserveOriginalGaugePrecision(body, original).dateTimeUTC).toBe(original.dateTimeUTC);
  const changed = { dateTimeUTC: '2026-10-27T19:19:38.000Z' };
  expect(preserveOriginalGaugePrecision(changed, original)).toBe(changed);
  expect(preserveOriginalGaugePrecision({}, original)).toEqual({});
});

const receipt = { schemaVersion: 1, driverId: 'd', companyId: 'c', originalPacketId: 'p', payloadDigest: 'stale', appliedEventId: 'edit-recovered', appliedRevision: 'rev', topInches: 116, bbls: 80 };
const original = { driverId: 'd', companyId: 'c', tankTopInches: 116, bblsTaken: 80, lastPullDeliveredEventId: 'edit-recovered', lastPullDeliveredRevision: 'rev' };
const outbox = { driverId: 'd', companyId: 'c', originalPacketId: 'p', eventId: 'edit-recovered', completed: true, stage: 'done', revision: 'rev', measurements: { tankTopInches: 116, bblsTaken: 80 } };
const base = { receipt, original, outbox, driverId: 'd', companyId: 'c', originalPacketId: 'p', payloadDigest: 'stale' };

it('requires exact reviewed request, tenant, completed delivery and canonical measurements', () => {
  expect(verifiedEditRecovery(base)).toBe(true);
  for (const patch of [{ receipt: null }, { payloadDigest: 'other' }, { driverId: 'other' }, { companyId: 'other' }, { originalPacketId: 'other' }, { outbox: { ...outbox, completed: false } }, { outbox: { ...outbox, originalPacketId: 'other' } }, { original: { ...original, tankTopInches: 108 } }, { receipt: { ...receipt, appliedRevision: 'other' } }, { outbox: { ...outbox, measurements: { tankTopInches: 116, bblsTaken: 81 } } }]) {
    expect(verifiedEditRecovery({ ...base, ...patch })).toBe(false);
  }
});

it('verifies a historical correction without replacing a newer last-load signal', () => {
  const historical = { ...base, receipt: { ...receipt, appliedRevision: '' },
    original: { ...original, activeEditEventId: receipt.appliedEventId, editCount: 2, lastPullDeliveredEventId: 'older' },
    outbox: { ...outbox, revision: '', isLatestPull: false, sequence: 2 } };
  expect(verifiedEditRecovery(historical)).toBe(true);
  expect(verifiedEditRecovery({ ...historical, original: { ...historical.original, activeEditEventId: 'different' } })).toBe(false);
  expect(verifiedEditRecovery({ ...historical, outbox: { ...historical.outbox, completed: false } })).toBe(false);
});
