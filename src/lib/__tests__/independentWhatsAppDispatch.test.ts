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
  assert.ok(message.indexOf('*JOB*') < message.indexOf('*SCHEDULE*'));
  assert.ok(message.indexOf('*SCHEDULE*') < message.indexOf('*ASSIGNED DRIVERS*'));
  assert.match(message, /\*ASSIGNED DRIVERS\*\n\*SHIFT NOT SET\*\n- Demo driver/);
  assert.ok(message.indexOf('*ASSIGNED DRIVERS*') < message.indexOf('*PICKUP / SOURCE*'));
  assert.match(message, /^\*URGENT DISPATCH\*/);
  assert.match(message, /\*DESCRIPTION \/ INSTRUCTIONS\*\nASAP\. Pickup location is driver choice\./);
  assert.match(message, /\n\n\*PICKUP \/ SOURCE\*\n/);
  assert.match(message, /\n\n\*DELIVERY \/ DESTINATION\*\n/);
  assert.match(message, /\*DELIVERY \/ DESTINATION\*\nGBU Zeus 34X-8G\nRoute to Delivery — confirm exact site:\nConfirm this is the exact site before driving; Google may choose a similar name\.\nhttps:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=GBU%20Zeus%2034X-8G&travelmode=driving/);
  assert.match(message, /react with a thumbs-up to this dispatch message/);
  assert.match(message, /reply ACK privately to dispatch/);
});
test('groups assigned crew by job shift in shared and personal messages', () => {
  const crew = [
    { key: 'outside:d1', name: 'Day one', source: 'outside' as const, shift: 'day' as const, assignedAt: '' },
    { key: 'outside:d2', name: 'Night one', source: 'outside' as const, shift: 'night' as const, assignedAt: '' },
    { key: 'outside:d3', name: 'Day two', source: 'outside' as const, shift: 'day' as const, assignedAt: '' },
  ];
  const message = buildIndependentWhatsAppText({ ...job, drivers: crew });
  assert.match(message, /\*ASSIGNED DRIVERS\*\n\*DAY SHIFT\*\n- Day one\n- Day two\n\n\*NIGHT SHIFT\*\n- Night one/);
  assert.match(decodeURIComponent(independentWhatsAppDriverUrl({ ...job, drivers: crew }, 'Day one', '+17015550123')!.split('?text=')[1]),
    /\*DAY SHIFT\*\n- Day one\n- Day two\n\n\*NIGHT SHIFT\*\n- Night one/);
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

test('scheduled urgency uses plain-text headings that survive the WhatsApp redirect', () => {
  const now = Date.parse('2026-11-23T12:00:00.000Z');
  const clean = { ...job, notes: '' };
  assert.equal(independentDispatchUrgency({ ...clean, scheduledAt: '2026-11-23T12:30:00.000Z' }, now), 'urgent');
  assert.equal(independentDispatchUrgency({ ...clean, scheduledAt: '2026-11-23T14:00:00.000Z' }, now), 'soon');
  assert.equal(independentDispatchUrgency({ ...clean, scheduledAt: '2026-11-24T12:00:00.000Z' }, now), 'routine');
  assert.equal(independentDispatchUrgency({ ...clean, scheduledAt: '' }, now), 'routine');
  assert.match(buildIndependentWhatsAppText({ ...clean, scheduledAt: '2026-11-23T14:00:00.000Z' }, undefined, now), /^\*UPCOMING DISPATCH\*/);
  assert.match(buildIndependentWhatsAppText({ ...clean, scheduledAt: '' }, undefined, now), /^\*JOB DISPATCH\*/);
});

test('retains exact operator work description and separate dispatch-selected pickup', () => {
  const exact = 'Need 500 barrels of production water.\nLeave sample measurements unchanged.';
  const message = buildIndependentWhatsAppText({ ...job, notes: exact, pickup: 'Dispatch-selected water supplier' }, undefined,
    Date.parse('2026-11-23T12:00:00.000Z'));
  assert.ok(message.includes(`*DESCRIPTION / INSTRUCTIONS*\n${exact}\n\n*PICKUP / SOURCE*\nDispatch-selected water supplier`));
  assert.ok(message.includes('Delivery / Destination') === false);
  assert.match(message, /\*DELIVERY \/ DESTINATION\*/);
});

test('includes approved access maps on special well jobs and keeps emoji out of WhatsApp links', () => {
  const special = { ...job, pickup: 'Daredevil Fed. 2-2-14H', destination: 'Pad 390 (Phazor Fed. 3-1-13H)' };
  const guides = [{ id: 'access', title: 'Barnstormer, Daredevil and Phazor', locations: ['Barnstormer', 'Daredevil', 'Phazor'],
    imageUrls: ['https://firebasestorage.googleapis.com/map-one', 'https://firebasestorage.googleapis.com/map-two'] }];
  const linked = decodeURIComponent(independentWhatsAppGroupShareUrl(special, guides).split('?text=')[1]);
  assert.match(linked, /ACCESS PHOTOS/);
  assert.match(linked, /Photo 1 — satellite overview: https:\/\/firebasestorage.googleapis.com\/map-one/);
  assert.match(linked, /Photo 2 — marked safe turn \/ avoid farmer road: https:\/\/firebasestorage.googleapis.com\/map-two/);
  assert.doesNotMatch(linked, /Google Maps directions:|PAD LOCATION ONLY|DRIVE TO PHAZOR/);
  assert.doesNotMatch(linked, /🚨/);
  const copy = buildIndependentWhatsAppText(special, undefined, Date.now(), guides, true);
  assert.match(copy, /^🚨🚨🚨🚨🚨👆🏽/);
  assert.match(copy, /\*PICKUP \/ SOURCE\*\nDaredevil Fed\. 2-2-14H\nRoute to Pickup — confirm exact site with dispatch:/);
  assert.match(copy, /\*DELIVERY \/ DESTINATION\*\nPad 390 \(Phazor Fed\. 3-1-13H\)\nRoute to Delivery — confirm exact site with dispatch:/);
  assert.doesNotMatch(copy, /query=Daredevil%20Fed|query=Pad%20390/);
});

test('includes one planned route only when the destination pad is identified', () => {
  const guide = { id: 'access', title: 'Approved access', locations: ['Barnstormer'], imageUrls: ['https://example.com/map'],
    routeWaypoints: [{ lat: 47.6912663, lng: -103.4562861 }, { lat: 47.689123, lng: -103.453253 }, { lat: 47.689152, lng: -103.440293 }],
    padPins: [
      { label: 'Barnstormer 1/2', location: 'Barnstormer', matchTerms: ['Barnstormer 1', 'Barnstormer 2'], lat: 47.673974, lng: -103.410378, url: 'https://maps.app.goo.gl/one' },
      { label: 'Barnstormer SWD', location: 'Barnstormer', matchTerms: ['Barnstormer SWD'], lat: 47.677885, lng: -103.400148, url: 'https://maps.app.goo.gl/two' },
    ] };
  const specific = buildIndependentWhatsAppText({ ...job, destination: 'Barnstormer 1' }, undefined, Date.now(), [guide]);
  assert.match(specific, /\*DELIVERY \/ DESTINATION\*\nBarnstormer 1\nGPS pin: 47\.673974° N, 103\.410378° W\nPin drop: https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=47\.673974%2C-103\.410378\nRoute to Delivery:\nOpen this route first\. Verify turns 1, 2 and 3 before driving; Google may recalculate\.\nhttps:\/\/www\.google\.com\/maps\/dir\/\?/);
  assert.equal((specific.match(/waypoints=/g) || []).length, 1);
  assert.match(specific, /destination=47\.673974%2C-103\.410378/);
  const ambiguous = buildIndependentWhatsAppText({ ...job, destination: 'Barnstormer' }, undefined, Date.now(), [guide]);
  assert.match(ambiguous, /Route to Delivery — confirm exact site with dispatch:/);
  assert.doesNotMatch(ambiguous, /Barnstormer SWD|waypoints=/);
  const otherDaredevil = buildIndependentWhatsAppText({ ...job, destination: 'Daredevil Fed. 2-2-14H' }, undefined, Date.now(), [{
    ...guide, locations: ['Daredevil'], padPins: [{ label: 'Daredevil 1', location: 'Daredevil',
      matchTerms: ['Daredevil 1'], url: 'https://maps.app.goo.gl/four', lat: 47.673911, lng: -103.387325 }],
  }]);
  assert.match(otherDaredevil, /Route to Delivery:\nOpen this route first\./);
  assert.match(otherDaredevil, /destination=47\.673911%2C-103\.387325/);
});

test('shared Daredevil job uses the saved delivery pin instead of a Google name search', () => {
  const guide = { id: 'access', title: 'Approved access', locations: ['Daredevil'], imageUrls: ['https://example.com/map'],
    padPins: [{ label: 'Daredevil 1', location: 'Daredevil', matchTerms: ['Daredevil 1'],
      url: 'https://maps.app.goo.gl/qAVybqs8LYATet1r8', lat: 47.673911, lng: -103.387325 }],
    routeWaypoints: [{ lat: 47.6912663, lng: -103.4562861 }, { lat: 47.689123, lng: -103.453253 }, { lat: 47.689152, lng: -103.440293 }] };
  const message = buildIndependentWhatsAppText({ ...job, pickup: 'County Road 30', destination: 'Daredevil 1' }, undefined, Date.now(), [guide]);
  assert.match(message, /\*PICKUP \/ SOURCE\*\nCounty Road 30\nRoute to Pickup — confirm exact site:\nConfirm this is the exact site before driving; Google may choose a similar name\.\nhttps:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=County%20Road%2030&travelmode=driving/);
  assert.match(message, /\*DELIVERY \/ DESTINATION\*\nDaredevil 1\nGPS pin: 47\.673911° N, 103\.387325° W\nPin drop: https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=47\.673911%2C-103\.387325\nRoute to Delivery:\nOpen this route first\. Verify turns 1, 2 and 3 before driving; Google may recalculate\.\nhttps:\/\/www\.google\.com\/maps\/dir\/\?/);
  assert.ok(message.indexOf('*ASSIGNED DRIVERS*') < message.indexOf('*DELIVERY / DESTINATION*'));
  assert.ok(message.indexOf('*DELIVERY / DESTINATION*') < message.indexOf('*ACCESS PHOTOS'));
  assert.doesNotMatch(message, /PAD LOCATION ONLY|qAVybqs8LYATet1r8/);
  assert.doesNotMatch(message, /query=Daredevil%201/);
  assert.match(message, /waypoints=47\.6912663/);
  const reverse = buildIndependentWhatsAppText({ ...job, pickup: 'Daredevil 1', destination: 'Sample disposal site' }, undefined, Date.now(), [guide]);
  assert.match(reverse, /\*PICKUP \/ SOURCE\*\nDaredevil 1\nGPS pin: 47\.673911° N, 103\.387325° W\nPin drop: https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=47\.673911%2C-103\.387325\nRoute to Pickup:\nOpen this route first\./);
  assert.match(reverse, /\*DELIVERY \/ DESTINATION\*\nSample disposal site\nRoute to Delivery — confirm exact site:\nConfirm this is the exact site before driving; Google may choose a similar name\.\nhttps:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=Sample%20disposal%20site&travelmode=driving/);
  assert.equal((reverse.match(/waypoints=/g) || []).length, 1);
});

test('one-site service jobs omit empty legs and multi-stop jobs route each stop in order', () => {
  const oneSite = buildIndependentWhatsAppText({ ...job, pickup: '', destination: 'Hot oiler well pad', additionalStops: [] });
  assert.doesNotMatch(oneSite, /PICKUP \/ SOURCE|Not specified/);
  assert.match(oneSite, /\*DELIVERY \/ DESTINATION\*\nHot oiler well pad\nRoute to Delivery — confirm exact site:/);
  const stops = buildIndependentWhatsAppText({ ...job, pickup: 'Yard', additionalStops: ['47.5,-103.4', 'Transfer terminal'], destination: 'Well pad' });
  assert.ok(stops.indexOf('*PICKUP / SOURCE*') < stops.indexOf('*STOP 1*'));
  assert.ok(stops.indexOf('*STOP 1*') < stops.indexOf('*STOP 2*'));
  assert.ok(stops.indexOf('*STOP 2*') < stops.indexOf('*DELIVERY / DESTINATION*'));
  assert.match(stops, /\*STOP 1\*\n47\.5,-103\.4\nGPS pin: 47\.5° N, 103\.4° W\nPin drop: .*\nRoute to Stop 1:/);
  assert.match(stops, /\*STOP 2\*\nTransfer terminal\nRoute to Stop 2 — confirm exact site:/);
});

test('special farmer handoff keeps each map with its own location and avoids duplicate pad links', () => {
  const guide = { id: 'access', title: 'Barnstormer, Daredevil and Phazor', locations: ['Barnstormer', 'Daredevil', 'Phazor'],
    imageUrls: ['https://example.com/satellite', 'https://example.com/safe-turn'],
    padPins: [
      { label: 'Daredevil 1', location: 'Daredevil', matchTerms: ['Daredevil 1'],
        url: 'https://maps.app.goo.gl/qAVybqs8LYATet1r8', lat: 47.673911, lng: -103.387325 },
      { label: 'Phazor all', location: 'Phazor', coversFamily: true,
        url: 'https://maps.app.goo.gl/HHcNVPWq6bvPT41x6', lat: 47.674216, lng: -103.365621 },
    ],
    routeWaypoints: [{ lat: 47.6912663, lng: -103.4562861 }, { lat: 47.689123, lng: -103.453253 }, { lat: 47.689152, lng: -103.440293 }] };
  const message = buildIndependentWhatsAppText({ ...job, pickup: 'Daredevil Fed. 2-2-14H',
    destination: 'Pad 390 (Phazor Fed. 3-1-13H)' }, undefined, Date.now(), [guide]);
  assert.match(message, /\*PICKUP \/ SOURCE\*\nDaredevil Fed\. 2-2-14H\nGPS pin: 47\.673911° N, 103\.387325° W\nPin drop: https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=47\.673911%2C-103\.387325\nRoute to Pickup:\nOpen this route first\. Verify turns 1, 2 and 3 before driving; Google may recalculate\.\nhttps:\/\/www\.google\.com\/maps\/dir\/\?/);
  assert.match(message, /\*DELIVERY \/ DESTINATION\*\nPad 390 \(Phazor Fed\. 3-1-13H\)\nGPS pin: 47\.674216° N, 103\.365621° W\nPin drop: https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=47\.674216%2C-103\.365621\nRoute to Delivery:\nOpen this route first\. Verify turns 1, 2 and 3 before driving; Google may recalculate\.\nhttps:\/\/www\.google\.com\/maps\/dir\/\?/);
  assert.equal((message.match(/waypoints=/g) || []).length, 2);
  assert.match(message, /destination=47\.673911%2C-103\.387325/);
  assert.match(message, /destination=47\.674216%2C-103\.365621/);
  const routes = message.match(/https:\/\/www\.google\.com\/maps\/dir\/\?[^\s]+/g) || [];
  assert.equal(routes.length, 2);
  for (const route of routes) {
    const params = new URL(route).searchParams;
    assert.equal(params.get('waypoints'), '47.6912663,-103.4562861|47.689123,-103.453253|47.689152,-103.440293');
    assert.equal(params.get('travelmode'), 'driving');
  }
  assert.doesNotMatch(message, /query=Daredevil%20Fed|query=Pad%20390/);
  assert.doesNotMatch(message, /PAD LOCATION ONLY|maps\.app\.goo\.gl\/HHcNVPWq6bvPT41x6/);
  assert.ok(message.indexOf('*ACCESS PHOTOS') > message.indexOf('*DELIVERY / DESTINATION*'));
});
