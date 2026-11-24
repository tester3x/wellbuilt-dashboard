import assert from 'node:assert/strict';
import test from 'node:test';
import { googleMapsDirectionsUrl, googleMapsSearchUrl, padPinsForJob, routeGuidesForJob } from '../independentRouteGuides';

const guide = { id: 'access', title: 'Approved access', locations: ['Barnstormer', 'Daredevil', 'Phazor'], imageUrls: ['https://example.com/map.jpg'] };

test('matches a named well at pickup, delivery, or asset without matching unrelated names', () => {
  assert.deepEqual(routeGuidesForJob({ pickup: 'Daredevil Fed. 2-2-14H', destination: 'Pad 390 (Phazor Fed. 3-1-13H)' }, [guide]), [guide]);
  assert.deepEqual(routeGuidesForJob({ destination: 'Barnstormer 410' }, [guide]), [guide]);
  assert.deepEqual(routeGuidesForJob({ asset: 'Phazor 3', destination: 'Pad 390' }, [guide]), [guide]);
  assert.deepEqual(routeGuidesForJob({ destination: 'Barnstormers Cafe' }, [guide]), []);
});

test('encodes Google map lookups and avoids guessing routes from alternate pickup sites', () => {
  assert.equal(googleMapsSearchUrl('Pad 390 (Phazor Fed. 3-1-13H)'),
    'https://www.google.com/maps/search/?api=1&query=Pad%20390%20(Phazor%20Fed.%203-1-13H)');
  assert.equal(googleMapsDirectionsUrl('White Owl Epping or White Owl Tioga', 'GBU Zeus'), null);
  assert.match(googleMapsDirectionsUrl('Shop', 'GBU Zeus')!, /origin=Shop&destination=GBU%20Zeus/);
});

test('shows exact pad pin choices for only the named well family', () => {
  const withPins = { ...guide, padPins: [
    { label: 'Barnstormer 1/2', location: 'Barnstormer', url: 'https://maps.app.goo.gl/one' },
    { label: 'Barnstormer SWD', location: 'Barnstormer', url: 'https://maps.app.goo.gl/two' },
    { label: 'Phazor all', location: 'Phazor', url: 'https://maps.app.goo.gl/three' },
  ] };
  assert.deepEqual(padPinsForJob({ destination: 'Barnstormer 3' }, withPins).map(pin => pin.label), ['Barnstormer 1/2', 'Barnstormer SWD']);
  assert.deepEqual(padPinsForJob({ destination: 'Pad 390 (Phazor Fed. 3-1-13H)' }, withPins).map(pin => pin.label), ['Phazor all']);
});
