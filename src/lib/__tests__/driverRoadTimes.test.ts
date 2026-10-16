import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriverRoadComparison } from '../driverRoadTimes.ts';
const a = {lat:48,lng:-103}, b = {lat:47,lng:-104};
test('basic road lookup shares identical legs only within one comparison', async () => {
 let calls=0;
 const fetcher = (async (_url: unknown, init: RequestInit) => {
  calls++;
  const body=JSON.parse(init.body as string);
  assert.equal(body.routingPreference,'TRAFFIC_UNAWARE');
  assert.equal(body.origins.length,1); assert.equal(body.destinations.length,1);
  return new Response(JSON.stringify([{condition:'ROUTE_EXISTS',status:{},duration:'600s',distanceMeters:1609.344}]));
 }) as typeof fetch;
 const first=createDriverRoadComparison({apiKey:'fixture',fetcher});
 const results=await Promise.all([first.roadTime(a,b),first.roadTime(a,b)]);
 assert.equal(calls,1); assert.equal(results[0]?.minutes,10);assert.equal(results[0]?.miles,1);
 await createDriverRoadComparison({apiKey:'fixture',fetcher}).roadTime(a,b);
 assert.equal(calls,2);
});
test('missing key, aborted comparisons and API failures never fabricate travel', async () => {
 let calls=0;const fetcher=(async()=>{calls++;return new Response(JSON.stringify([{error:{code:403}}]));}) as typeof fetch;
 assert.equal(await createDriverRoadComparison({apiKey:'',fetcher}).roadTime(a,b),null);
 const controller=new AbortController();controller.abort();
 assert.equal(await createDriverRoadComparison({apiKey:'fixture',fetcher,signal:controller.signal}).roadTime(a,b),null);
 assert.equal(calls,0);
 const comparison=createDriverRoadComparison({apiKey:'fixture',fetcher});
 assert.equal(await comparison.roadTime(a,b),null);assert.equal(comparison.usage().failures,1);
});
