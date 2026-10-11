import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCustomTypeRateOverrides, rateIdentityForInvoice } from '../jobTypeRateCore.ts';
import type { CustomJobType } from '../companySettings.ts';

const standby: CustomJobType = {
  id: 'standby', label: 'Standby', baseJobTypeId: 'service-work', payBasis: 'hourly',
  lifecycleShape: 'onsite_only', packages: ['water-hauling'], capabilities: ['lifecycle'],
};

test('optional operator rate is attached to the SW primary without changing other operators', () => {
  const sheets = {
    Slawson: [{ jobType: 'Service Work', method: 'hourly' as const, rate: 160 }],
    Other: [{ jobType: 'Service Work', method: 'hourly' as const, rate: 140 }],
  };
  const updated = addCustomTypeRateOverrides(sheets, standby, { Slawson: 80 });
  assert.deepEqual(updated.Slawson[0].subtypeRates, { Standby: 80 });
  assert.equal(updated.Slawson[0].rate, 160);
  assert.deepEqual(updated.Other, sheets.Other);
  assert.equal(sheets.Slawson[0].subtypeRates, undefined);
});

test('special rate with a different basis becomes an explicitly associated rule', () => {
  const updated = addCustomTypeRateOverrides({ Slawson: [{ jobType: 'Service Work', method: 'per_bbl', rate: 2 }] }, standby, { Slawson: 80 });
  assert.deepEqual(updated.Slawson[1], { jobType: 'Standby', primaryJobType: 'Service Work', method: 'hourly', rate: 80 });
  assert.throws(() => addCustomTypeRateOverrides({}, standby, { Slawson: -1 }), /Invalid rate/);
});

test('SW Production Water is hourly service identity; ordinary PW remains per BBL identity', () => {
  assert.deepEqual(rateIdentityForInvoice({ commodityType: 'Production Water', serviceType: 'Production Water' }, []),
    { primary: 'Service Work', subtype: 'Production Water', payBasis: 'hourly' });
  assert.deepEqual(rateIdentityForInvoice({ commodityType: 'Production Water' }, []),
    { primary: 'Production Water', subtype: '' });
  assert.deepEqual(rateIdentityForInvoice({ commodityType: 'Production Water (hr)' }, []),
    { primary: 'Service Work', subtype: 'Production Water', payBasis: 'hourly' });
});

test('custom type metadata supplies primary and pay basis', () => {
  assert.deepEqual(rateIdentityForInvoice({ commodityType: 'Standby', serviceType: 'Standby' }, [standby]),
    { primary: 'Service Work', subtype: 'Standby', payBasis: 'hourly' });
});
