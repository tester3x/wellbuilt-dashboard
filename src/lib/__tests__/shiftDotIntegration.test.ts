import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShiftResolveEnvelope, shiftDotForDriver } from '../shiftDotCore.ts';

const MIKE = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const S24 = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';

// End-to-end: the callable's wire envelope → client parse → per-driver dot render.
test('a response with Mike=open and S24=none renders GREEN and RED respectively', () => {
  const envelope = {
    results: [
      { driverId: MIKE, state: 'open' as const, asOf: '2026-09-16T00:00:00.000Z' },
      { driverId: S24, state: 'none' as const, asOf: '2026-09-16T00:00:00.000Z' },
    ],
    companyId: null, // no-company (see-all) caller → client cross-company guard is skipped
    asOf: '2026-09-16T00:00:00.000Z',
  };
  const { resultsByDriverId, companyId } = parseShiftResolveEnvelope(envelope);

  const mikeDot = shiftDotForDriver({
    canonicalDriverId: MIKE, companyId: 'liquid-gold',
    resultsByDriverId, resolvedCompanyId: companyId, loading: false, error: false,
  });
  const s24Dot = shiftDotForDriver({
    canonicalDriverId: S24, companyId: 'liquid-gold',
    resultsByDriverId, resolvedCompanyId: companyId, loading: false, error: false,
  });

  assert.equal(mikeDot.dot, 'green');
  assert.equal(mikeDot.title, 'On shift');
  assert.equal(s24Dot.dot, 'red');
  assert.equal(s24Dot.title, 'Off shift');
});

test('full canonical driverId is the map key — an abbreviated id does not match (gray)', () => {
  const { resultsByDriverId } = parseShiftResolveEnvelope({
    results: [{ driverId: MIKE, state: 'open', asOf: 'x' }], companyId: null, asOf: 'x',
  });
  assert.equal(shiftDotForDriver({ canonicalDriverId: '2cad521c', resultsByDriverId }).dot, 'gray');
  assert.equal(shiftDotForDriver({ canonicalDriverId: MIKE, resultsByDriverId }).dot, 'green');
});

test('a company-scoped caller still matches its own drivers (companyId echo)', () => {
  const { resultsByDriverId, companyId } = parseShiftResolveEnvelope({
    results: [{ driverId: MIKE, state: 'open', asOf: 'x' }], companyId: 'liquid-gold', asOf: 'x',
  });
  assert.equal(shiftDotForDriver({
    canonicalDriverId: MIKE, companyId: 'liquid-gold', resolvedCompanyId: companyId, resultsByDriverId,
  }).dot, 'green');
});

test('error / empty envelope → gray (never a false red)', () => {
  const { resultsByDriverId } = parseShiftResolveEnvelope(null);
  assert.equal(shiftDotForDriver({ canonicalDriverId: MIKE, resultsByDriverId, error: true }).dot, 'gray');
  assert.equal(shiftDotForDriver({ canonicalDriverId: MIKE, resultsByDriverId }).dot, 'gray');
});
