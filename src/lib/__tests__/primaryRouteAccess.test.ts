import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const screen = readFileSync(new URL('../../components/admin/DriversTab.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../secureDriverAdmin.ts', import.meta.url), 'utf8');
test('primary authority has separate controls and never substitutes for route visibility', () => {
  assert.match(screen, /selectedRoutes\.includes\(route\)/);
  assert.match(screen, /primaryRoutes\.includes\(route\)/);
  assert.match(screen, /Primary on all routes, including future routes/);
  assert.match(screen, /More than one driver can be primary/);
});
test('primary updates use canonical identity, revision checking and acknowledged scoped callables', () => {
  assert.match(api, /httpsCallable\(getFirebaseFunctions\(\), 'staffWritePrimaryRouteAssignment'\)/);
  assert.match(api, /httpsCallable\(getFirebaseFunctions\(\), 'staffGetPrimaryRouteAssignments'\)/);
  assert.match(api, /data\.driverId !== params\.driverId/);
  assert.match(screen, /expectedRevision: target\.primaryRouteRevision \|\| 0/);
  assert.match(screen, /Primary access was not confirmed/);
});
test('primary save does not write assigned routes or legacy approved identities', () => {
  const start = screen.indexOf('const savePrimaryRoutes =');
  const end = screen.indexOf('// ── Assign routes', start);
  assert.ok(start >= 0 && end > start);
  const handler = screen.slice(start, end);
  assert.doesNotMatch(handler, /assignedRoutes:|assignedWells:|drivers\/approved|set\(ref|update\(ref/);
  assert.match(handler, /assignmentGenRef\.current === generation/);
});
