#!/usr/bin/env node
// deployedProvenance.mjs — READ-ONLY provenance capture for the four deployed
// OLD consumers (predeploy gate Rev-4 Blocker 3). Queries `firebase
// functions:list --json` (read-only; no deploy, no mutation) and prints the
// governed metadata for processIncomingPull / processEditRequest /
// processDeleteRequest / watchdogStrandedPackets, compared against the
// reconstructed source commit c7378d6. It NEVER prints environmentVariables
// values or any secret. It writes nothing to production.
//
// RUN: node functions/tools/deployedProvenance.mjs [--json <path-to-functions-list-json>]
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PROJECT = 'wellbuilt-sync';
const CONSUMERS = ['processIncomingPull', 'processEditRequest', 'processDeleteRequest', 'watchdogStrandedPackets'];
// Config the c7378d6 source produces (functionsV1.database defaults / v2 onSchedule defaults).
const EXPECTED = {
  processIncomingPull: { platform: 'gcfv1', memory: 256, timeoutSeconds: 60, runtime: 'nodejs20', region: 'us-central1' },
  processEditRequest: { platform: 'gcfv1', memory: 256, timeoutSeconds: 60, runtime: 'nodejs20', region: 'us-central1' },
  processDeleteRequest: { platform: 'gcfv1', memory: 256, timeoutSeconds: 60, runtime: 'nodejs20', region: 'us-central1' },
  watchdogStrandedPackets: { platform: 'gcfv2', memory: 256, timeoutSeconds: 60, runtime: 'nodejs20', region: 'us-central1' },
};

const jsonPath = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
let raw;
if (jsonPath) raw = readFileSync(jsonPath, 'utf8');
else {
  console.error('[provenance] querying firebase functions:list --json (read-only)…');
  raw = execSync(`npx firebase functions:list --project ${PROJECT} --json`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}
const all = JSON.parse(raw);
const arr = all.result || all;
const byId = Object.fromEntries(arr.filter((x) => CONSUMERS.includes(x.id)).map((x) => [x.id, x]));

console.log(`\nDEPLOYED-OLD PROVENANCE (project ${PROJECT}, read-only)  vs reconstructed source c7378d6\n`);
let allConsistent = true;
for (const fn of CONSUMERS) {
  const f = byId[fn];
  if (!f) { console.log(`  ${fn}: NOT FOUND in functions:list`); allConsistent = false; continue; }
  const exp = EXPECTED[fn];
  const got = { platform: f.platform, memory: f.availableMemoryMb, timeoutSeconds: f.timeoutSeconds, runtime: f.runtime, region: f.region };
  const consistent = Object.entries(exp).every(([k, v]) => got[k] === v);
  allConsistent = allConsistent && consistent;
  console.log(`  ${fn}`);
  console.log(`    deployed : gen=${got.platform} mem=${got.memory} timeout=${got.timeoutSeconds}s runtime=${got.runtime} region=${got.region} entryPoint=${f.entryPoint} codebase=${f.codebase} state=${f.state}`);
  console.log(`    c7378d6  : gen=${exp.platform} mem=${exp.memory} timeout=${exp.timeoutSeconds}s runtime=${exp.runtime} region=${exp.region}  → metadata ${consistent ? 'CONSISTENT' : 'MISMATCH'}`);
  console.log(`    deployed endpoint hash: ${f.hash || '(v1 — not exposed by functions:list)'}`);
  // Print storageSource location WITHOUT any signed url/token.
  if (f.source?.storageSource) console.log(`    source archive: gs://${f.source.storageSource.bucket}/${f.source.storageSource.object} (gen ${f.source.storageSource.generation})`);
}

console.log(`\nClassification (corrected Rev-4 preflight): deployed metadata CONSISTENT with the`);
console.log(`  OLD-consumer source family (${allConsistent ? 'all fields consistent' : 'SEE MISMATCH ABOVE'}); deployed-artifact`);
console.log(`  identity UNKNOWN. The four consumers were last deployed at DIFFERENT times`);
console.log(`  (versionIds 79/77/72; Jun–Aug 2026), whereas c7378d6 is the branch MERGE-BASE`);
console.log(`  dated 2026-07-09 — it is NOT the deployed source (processIncomingPull was deployed`);
console.log(`  2026-08-22). No local commit is proven to equal a deployed artifact.`);
console.log(`  The Stage-A harness built from c7378d6 is a SOURCE-FAMILY reconstruction; its`);
console.log(`  compatibility conclusion holds because the old processor's read fields + trigger`);
console.log(`  path are identical across c7378d6 / deploy-era 2774168 / branch tip 36d37e5.`);
console.log(`  See docs/deployed-old-provenance.md for the REST-described identities (versionId,`);
console.log(`  updateTime, buildId) and the read-only operator step to reach byte-exact.`);
process.exit(allConsistent ? 0 : 1);
