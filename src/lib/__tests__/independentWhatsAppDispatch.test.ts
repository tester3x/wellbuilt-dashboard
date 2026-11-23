import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildIndependentWhatsAppText,
  independentWhatsAppDriverUrl,
  independentWhatsAppGroupShareUrl,
  independentDispatchUrgency,
  normalizeWhatsAppNumber,
} from '../independentWhatsAppDispatch';

const job = {
  title: 'Zeus brine',
  customer: 'ExxonMobil',
  pickup: 'White Owl Epping or White Owl Tioga',
  destination: 'GBU Zeus 34X-8G',
  cargo: '2 loads of 10 PPG brine',
  reference: 'Rig 640',
  notes: 'ASAP. Pickup location is driver choice.',
  scheduledAt: '2026-11-23T15:00:00.000Z',
  requestedDriverCount: 2,
  jobContactName: 'Job contact',
  jobContactPhoneE164: '',
  drivers: [{key:'outside:d1',name:'Demo driver',source:'outside' as const,assignedAt:'2026-11-23T14:00:00.000Z'}],
  driverName: '',
};

test('prepares main WhatsApp share without guessing pickup or sending', () => {
  const url = independentWhatsAppGroupShareUrl(job);
  assert.ok(url.startsWith('https://wa.me/?text='));
  const message = decodeURIComponent(url.split('?text=')[1]);
  assert.match(message, /White Owl Epping or White Owl Tioga/);
  assert.match(message, /2 loads of 10 PPG brine/);
  assert.match(message, /Scheduled pickup \(UTC\)/);
  assert.match(message, /Assigned drivers:\nDemo driver/);
  assert.match(message, /🚨🚨🚨🚨🚨/);
  assert.match(message, /\*DESCRIPTION \/ INSTRUCTIONS\*\nASAP\. Pickup location is driver choice\./);
  assert.match(message, /\n\n\*PICKUP \/ SOURCE\*\n/);
  assert.match(message, /\n\n\*DELIVERY \/ DESTINATION\*\n/);
  assert.match(message, /reply ACK privately to dispatch/);
  assert.match(message, /Do not reply in the group/);
});
test('direct WhatsApp link uses exact verified international number and personalizes request', () => {
  const url = independentWhatsAppDriverUrl(job,'Demo driver','+17015550123');
  assert.ok(url?.startsWith('https://wa.me/17015550123?text='));
  assert.match(decodeURIComponent(url!.split('?text=')[1]), /reply ACK privately to dispatch/);
});
test('rejects missing and malformed numbers rather than selecting a wrong recipient', () => {
  for (const phone of [undefined, '', '7015550123', '+01234567890', '+123']) {
    assert.equal(normalizeWhatsAppNumber(phone), null);
    assert.equal(independentWhatsAppDriverUrl(job,'Demo',phone), null);
  }
});
test('message content is the same when generated independently', () => {
  assert.equal(decodeURIComponent(independentWhatsAppGroupShareUrl(job).split('?text=')[1]),buildIndependentWhatsAppText(job));
});

test('scheduled urgency uses red, orange, and yellow without guessing missing dates', () => {
  const now = Date.parse('2026-11-23T12:00:00.000Z');
  const clean = { ...job, notes: '' };
  assert.equal(independentDispatchUrgency({ ...clean, scheduledAt: '2026-11-23T12:30:00.000Z' }, now), 'urgent');
  assert.equal(independentDispatchUrgency({ ...clean, scheduledAt: '2026-11-23T14:00:00.000Z' }, now), 'soon');
  assert.equal(independentDispatchUrgency({ ...clean, scheduledAt: '2026-11-24T12:00:00.000Z' }, now), 'routine');
  assert.equal(independentDispatchUrgency({ ...clean, scheduledAt: '' }, now), 'routine');
  assert.match(buildIndependentWhatsAppText({ ...clean, scheduledAt: '2026-11-23T14:00:00.000Z' }, undefined, now), /🟠🟠🟠/);
  assert.match(buildIndependentWhatsAppText({ ...clean, scheduledAt: '' }, undefined, now), /🟡🟡🟡/);
});

test('retains exact operator work description and separate dispatch-selected pickup', () => {
  const exact = 'Need 500 barrels of production water.\nLeave sample measurements unchanged.';
  const message = buildIndependentWhatsAppText({ ...job, notes: exact, pickup: 'Dispatch-selected water supplier' }, undefined,
    Date.parse('2026-11-23T12:00:00.000Z'));
  assert.ok(message.includes(`*DESCRIPTION / INSTRUCTIONS*\n${exact}\n\n*PICKUP / SOURCE*\nDispatch-selected water supplier`));
  assert.ok(message.includes('Delivery / Destination') === false);
  assert.match(message, /\*DELIVERY \/ DESTINATION\*/);
});
