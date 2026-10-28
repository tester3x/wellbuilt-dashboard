import { verifiedEditRecovery, wbmEditRevisionKey } from '../wbmEditRevision';

it('deduplicates a retry but separates changed corrections without changing the parent pull', () => {
  const body = { originalPacketId: 'pull', tankLevelFeet: 9, bblsTaken: 80, idempotencyKey: 'edit' };
  expect(wbmEditRevisionKey('edit', body)).toBe(wbmEditRevisionKey('edit', { ...body }));
  expect(wbmEditRevisionKey('edit', body)).not.toBe(wbmEditRevisionKey('edit', { ...body, tankLevelFeet: 9 + 8 / 12 }));
  expect(body.originalPacketId).toBe('pull');
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
