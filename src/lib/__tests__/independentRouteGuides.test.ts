import assert from 'node:assert/strict';
import test from 'node:test';
import { googleMapsDirectionsUrl, googleMapsSearchUrl, identifiedPadPin, padPinsForJob, plannedGoogleRouteUrl, routeGuidesForJob } from '../independentRouteGuides';

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
    { label: 'Barnstormer 1/2', location: 'Barnstormer', url: 'https://maps.app.goo.gl/one', matchTerms: ['Barnstormer 1', 'Barnstormer 2'] },
    { label: 'Barnstormer SWD', location: 'Barnstormer', url: 'https://maps.app.goo.gl/two', matchTerms: ['Barnstormer SWD'] },
    { label: 'Phazor all', location: 'Phazor', url: 'https://maps.app.goo.gl/three' },
  ] };
  assert.deepEqual(padPinsForJob({ destination: 'Barnstormer 3' }, withPins).map(pin => pin.label), ['Barnstormer 1/2', 'Barnstormer SWD']);
  assert.deepEqual(padPinsForJob({ destination: 'Barnstormer 1' }, withPins).map(pin => pin.label), ['Barnstormer 1/2']);
  assert.deepEqual(padPinsForJob({ destination: 'Pad 390 (Phazor Fed. 3-1-13H)' }, withPins).map(pin => pin.label), ['Phazor all']);
  assert.equal(identifiedPadPin({ destination: 'Barnstormer 1' }, withPins)?.label, 'Barnstormer 1/2');
  assert.equal(identifiedPadPin({ destination: 'Phazor Fed. 3-1-13H' }, withPins), null);
  assert.equal(identifiedPadPin({ destination: 'Daredevil Fed. 2-2-14H' }, { ...guide, padPins: [
    { label: 'Daredevil 1', location: 'Daredevil', matchTerms: ['Daredevil 1'], url: 'https://maps.app.goo.gl/four' },
  ] }), null);
  assert.deepEqual(padPinsForJob({ pickup: 'Daredevil 1', destination: 'Pad 390 (Phazor Fed.)' }, withPins).map(pin => pin.label), ['Phazor all']);
});

test('planned directions start at the driver location and visit the three approved turns in order', () => {
  const guided = { ...guide, routeWaypoints: [
    { lat: 47.6912663, lng: -103.4562861 },
    { lat: 47.689123, lng: -103.453253 },
    { lat: 47.689152, lng: -103.440293 },
  ] };
  const url = new URL(plannedGoogleRouteUrl(guided, { label: 'Barnstormer 1/2', location: 'Barnstormer',
    url: 'https://maps.app.goo.gl/one', lat: 47.673974, lng: -103.410378 })!);
  assert.equal(url.searchParams.get('origin'), null);
  assert.equal(url.searchParams.get('destination'), '47.673974,-103.410378');
  assert.equal(url.searchParams.get('waypoints'), '47.6912663,-103.4562861|47.689123,-103.453253|47.689152,-103.440293');
  assert.equal(url.searchParams.get('travelmode'), 'driving');
});
