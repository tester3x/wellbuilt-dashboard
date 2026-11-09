import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickupJobType, pickupJobTypeFields, pickupTypeCorrectionState } from '../src/security/operational/pickupJobTypeCorrection.ts';

const base = {
  companyId: 'company', driverId: 'driver', dispatchId: 'dispatch',
  from: 'Service Work', to: 'Production Water',
  dispatch: {
    companyId: 'company', driverId: 'driver', status: 'in_progress',
    driverStage: 'on_site_pickup', jobTypeId: 'service-work',
  },
  invoice: {
    companyId: 'company', driverHash: 'driver', dispatchId: 'dispatch',
    status: 'open', invoicingMode: 'ticket_only', commodityType: 'Service Work',
    tickets: [], timeline: [{ type: 'depart' }, { type: 'arrive' }],
  },
};

test('an assigned driver can correct a single open pickup', () => {
  assert.equal(pickupTypeCorrectionState(base), 'apply');
  assert.equal(pickupTypeCorrectionState({ ...base, driverId: 'another' }), 'owner_mismatch');
  assert.equal(pickupTypeCorrectionState({ ...base, companyId: 'another' }), 'owner_mismatch');
});

test('a departure, pull, submitted ticket, split or transfer locks the type', () => {
  for (const invoice of [
    { timeline: [{ type: 'depart_site' }] },
    { packetId: 'outbox-pull' },
    { tickets: ['21139'] },
    { splitChainId: 'chain' },
    { transferSourceDocId: 'source' },
  ]) {
    assert.equal(pickupTypeCorrectionState({ ...base, invoice: { ...base.invoice, ...invoice } }), 'pickup_locked');
  }
  assert.equal(pickupTypeCorrectionState({
    ...base, dispatch: { ...base.dispatch, driverStage: 'en_route_dropoff' },
  }), 'pickup_locked');
});

test('a retry preserves the applied classification, while a stale request fails', () => {
  const applied = {
    ...base,
    invoice: { ...base.invoice, ...pickupJobTypeFields(base.to) },
    dispatch: { ...base.dispatch, jobTypeId: 'pw', pickupJobTypeCorrection: { from: base.from, to: base.to } },
  };
  assert.equal(pickupTypeCorrectionState(applied), 'already_applied');
  assert.equal(pickupTypeCorrectionState({ ...applied, from: 'Production Water (hr)' }), 'type_changed');
  assert.equal(pickupJobType('Fresh Water'), undefined);
  assert.equal(pickupJobTypeFields('Production Water (hr)').jobTypeId, 'service-work');
});
