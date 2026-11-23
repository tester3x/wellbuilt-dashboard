import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildIndependentWhatsAppText,
  independentWhatsAppDriverUrl,
  independentWhatsAppGroupShareUrl,
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
  assert.match(message, /Assigned drivers: Demo driver/);
});
test('direct WhatsApp link uses exact verified international number and personalizes request', () => {
  const url = independentWhatsAppDriverUrl(job,'Demo driver','+17015550123');
  assert.ok(url?.startsWith('https://wa.me/17015550123?text='));
  assert.match(decodeURIComponent(url!.split('?text=')[1]), /Please acknowledge this assignment/);
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
