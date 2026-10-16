import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArrivalHistory, historicalArrivalTravel, recommendDriverArrivals, type ArrivalInvoice, type ArrivalJob, type ArrivalSample } from '../driverArrivalRecommendations.ts';

const now = Date.UTC(2026, 9, 15, 18);
const point = { lat: 48, lng: -103 }, drop = { lat: 48.2, lng: -103.2 }, target = { lat: 48.4, lng: -103.4 };
const driver = (key: string) => ({ key, driverId: key, companyId: 'test-company', displayName: key });
const sample = (kind: ArrivalSample['kind'], minutes: number, location = 'drop'): ArrivalSample => ({ kind, minutes, location, driverId: 'busy' });
const history = [...Array.from({ length: 3 }, () => sample('unload', 20)), ...Array.from({ length: 3 }, () => sample('load', 30, 'pickup'))];
const job = (extra: Partial<ArrivalJob> = {}): ArrivalJob => ({ id: 'j1', driverId: 'busy', driverHash: 'busy', companyId: 'test-company', status: 'in_progress', jobType: 'pw',
  driverStage: 'on_site_dropoff', stageUpdatedAt: now - 5 * 60000, driverGpsAt: new Date(now).toISOString(), driverLat: point.lat, driverLng: point.lng,
  wellName: 'pickup', disposal: 'drop', ...extra });
const run = (extra: Partial<Parameters<typeof recommendDriverArrivals>[0]> = {}) => recommendDriverArrivals({
  drivers: [driver('busy'), driver('free')], jobs: [job(), job({ id: 'old', driverId: 'free', driverHash: 'free', status: 'completed' })],
  invoices: [], companyId: 'test-company', target, nowMs: now, jobsComplete: true, history,
  locate: name => name === 'drop' ? drop : name === 'pickup' ? point : null,
  roadTime: async from => ({ minutes: from === drop ? 15 : 20, miles: 10, source: 'road' }), ...extra,
});

test('farther free driver beats nearby busy driver; travel begins at release location', async () => {
  const rows = await run();
  assert.deepEqual(rows.map(r => [r.driverKey, r.arrivalMinutes]), [['free', 20], ['busy', 30]]);
  assert.equal(rows[1].releaseMinutes, 15);
  assert.match(rows[1].reasons.join(' '), /Available after current work at drop/);
});
test('GPS freshness and unavailable job feeds never fabricate availability', async () => {
  for (const patch of [
    { jobs: [job({ driverId: 'free', driverHash: 'free', status: 'completed', driverGpsAt: new Date(now - 16 * 60000).toISOString() })] },
    { jobsComplete: false }, { target: null },
  ]) {
    const rows = await run(patch);
    assert.equal(rows.find(r => r.driverKey === 'free')!.arrivalMinutes, null);
    assert.equal(rows.length, 2, 'everyone remains in the advisory result');
  }
});
test('only confirmed account logout excludes a calculation; shift start is not required', async () => {
  let calls = 0;
  const rows = await run({ accountPresence: () => 'logged_out',
    roadTime: async () => { calls++; return { minutes: 10, source: 'road' }; } });
  assert.equal(calls, 0);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.arrivalMinutes === null));
  assert.match(rows.find(r => r.driverKey === 'busy')!.reasons.join(' '), /account logged out/);
  const unknownPresence = await run({ accountPresence: () => 'unknown' });
  assert.equal(unknownPresence.find(r => r.driverKey === 'busy')!.arrivalMinutes, 30,
    'unknown account presence must not exclude someone with usable work evidence');
});
test('driving uses fresh GPS to remaining stop, then release point to new job', async () => {
  const calls: unknown[] = [];
  const rows = await run({ drivers: [driver('busy')], jobs: [job({ driverStage: 'en_route_dropoff' })],
    roadTime: async (from, to) => { calls.push([from, to]); return { minutes: 10, source: 'road' }; } });
  assert.equal(rows[0].arrivalMinutes, 40);
  assert.deepEqual(calls, [[point, drop], [drop, target]]);
  const stale = await run({ drivers: [driver('busy')], jobs: [job({ driverStage: 'en_route_dropoff', driverGpsAt: new Date(now - 16 * 60000).toISOString() })] });
  assert.equal(stale[0].arrivalMinutes, null);
});
test('known shared multi-haul unload is counted once; unclear multiple work is withheld', async () => {
  const jobs = [job({ invoiceDocId: 'i1' }), job({ id: 'j2', invoiceDocId: 'i2' })];
  const invoices = jobs.map((j, i) => ({ id: `i${i + 1}`, dispatchId: j.id, companyId: 'test-company', status: 'open', haulGroupId: 'g' }));
  const rows = await run({ drivers: [driver('busy')], jobs, invoices });
  assert.equal(rows[0].arrivalMinutes, 30);
  assert.match(rows[0].reasons.join(' '), /2 multi-haul jobs share one/);
  const unclear = await run({ drivers: [driver('busy')], jobs });
  assert.equal(unclear[0].arrivalMinutes, null);
});
test('pause, service work, remaining split stops and multiple loads retain selectable unknown rows', async () => {
  for (const patch of [{ status: 'paused' }, { jobType: 'service' }, { splitGroupId: 's', splitTotal: 2, splitSequence: 1 }, { loadCount: 2 }]) {
    const rows = await run({ drivers: [driver('busy')], jobs: [job(patch)] });
    assert.equal(rows.length, 1); assert.equal(rows[0].arrivalMinutes, null);
  }
});
test('destination changes never borrow the original SWD coordinates', async () => {
  const rows = await run({ drivers: [driver('busy')], jobs: [job({ hauledTo: 'new drop', disposalLat: drop.lat, disposalLng: drop.lng })] });
  assert.equal(rows[0].arrivalMinutes, null); assert.match(rows[0].reasons.join(' '), /Current drop-off location unavailable/);
});
test('overrunning a historical median is not silently treated as finished', async () => {
  const rows = await run({ drivers: [driver('busy')], jobs: [job({ stageUpdatedAt: now - 45 * 60000 })] });
  assert.equal(rows[0].arrivalMinutes, null); assert.match(rows[0].reasons.join(' '), /exceeded/);
});
test('pending queue is explained and not consumed; an orphan open invoice is not idle', async () => {
  const jobs = [job(), job({ id: 'pending', status: 'pending' })];
  const rows = await run({ jobs });
  assert.equal(rows.find(r => r.driverKey === 'busy')!.queueCount, 1);
  assert.match(rows.find(r => r.driverKey === 'busy')!.reasons.join(' '), /places this job next/);
  assert.equal(jobs[1].status, 'pending');
  const orphan = await run({ invoices: [{ id: 'orphan', companyId: 'test-company', driverId: 'free', status: 'open' }] });
  assert.equal(orphan.find(r => r.driverKey === 'free')!.arrivalMinutes, null);
});
test('canonical identity wins over another driver legacy hash; cross-company work is not borrowed', async () => {
  const rows = await run({ jobs: [job({ driverHash: 'free' })] });
  assert.equal(rows.find(r => r.driverKey === 'busy')!.arrivalMinutes, 30);
  assert.equal(rows.find(r => r.driverKey === 'free')!.arrivalMinutes, null);
  const cross = await run({ drivers: [{ ...driver('busy'), companyId: 'other' }] });
  assert.equal(cross[0].arrivalMinutes, null);
});
test('history ignores pauses, bad timestamps, cancelled/demo data and duplicate grouped unloads', () => {
  const event = (type: string, offset: number, locationName: string) => ({ type, timestamp: new Date(now + offset * 60000).toISOString(), locationName, ...point });
  const invoice: ArrivalInvoice = { id: 'i', companyId: 'test-company', driverId: 'busy', status: 'closed', commodityType: 'Production Water', wellName: 'pickup', hauledTo: 'drop',
    timeline: [event('arrive', -100, 'pickup'), event('depart_site', -70, 'pickup'), { ...event('arrive', -50, 'drop'), ...drop }, event('close', -30, 'drop')] };
  const samples = buildArrivalHistory([invoice, { ...invoice, id: 'duplicate' }, { ...invoice, status: 'cancelled' }, { ...invoice, companyId: 'wellbuilt-demo' }], 'test-company', now);
  assert.deepEqual(samples.map(s => [s.kind, s.minutes]), [['load', 30], ['drive', 20], ['unload', 20]]);
  assert.equal(historicalArrivalTravel(samples, point, drop), null, 'one observed trip is not enough');
  const paused = { ...invoice, timeline: [event('arrive', -100, 'pickup'), event('pause', -90, 'pickup'), event('depart_site', -70, 'pickup')] };
  assert.equal(buildArrivalHistory([paused], 'test-company', now).length, 0);
});

test('recorded trips come first; road provider is called only for insufficient directional history', async () => {
  let calls = 0;
  const trips: ArrivalSample[] = [18, 20, 22].map(minutes => ({ kind: 'drive', minutes, driverId: 'free', location: '', from: point, to: target }));
  const options = { drivers: [driver('free')], jobs: [job({ driverId: 'free', driverHash: 'free', status: 'completed' })],
    roadTime: async () => { calls++; return { minutes: 25, source: 'road' as const }; } };
  const known = await run({ ...options, history: trips });
  assert.equal(known[0].arrivalMinutes, 20);
  assert.match(known[0].reasons.join(' '), /history, 3 trips/);
  assert.equal(calls, 0, 'enough local history must avoid the external lookup entirely');
  const sparse = await run({ ...options, history: trips.slice(0, 2) });
  assert.equal(sparse[0].arrivalMinutes, 25);
  assert.equal(calls, 1);
  const reverse = await run({ ...options, history: trips.map(s => ({ ...s, from: target, to: point })) });
  assert.equal(reverse[0].arrivalMinutes, 25);
  assert.equal(calls, 2, 'reverse-direction trips cannot masquerade as the same route');
});

test('distance never eliminates a driver, including a distant assigned release location', async () => {
  const farDrop = { lat: 46, lng: -100 };
  const rows = await run({ locate: name => name === 'drop' ? farDrop : point,
    roadTime: async from => ({ minutes: from.lat === farDrop.lat ? 300 : 20, miles: from.lat === farDrop.lat ? 250 : 10, source: 'road' }) });
  assert.equal(rows.length, 2);
  const distant = rows.find(r => r.driverKey === 'busy')!;
  assert.equal(distant.arrivalMinutes, 315);
  assert.equal(distant.miles, 250);
  assert.equal(rows[0].driverKey, 'free');
  assert.match(distant.reasons.join(' '), /Available after current work at drop/);
});
