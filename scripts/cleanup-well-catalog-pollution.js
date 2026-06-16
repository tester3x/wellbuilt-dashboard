/**
 * cleanup-well-catalog-pollution.js — remove non-OG ND docs wrongly written into
 * `wells` / `wells_inactive` by the earlier status-only refresh.
 *
 * WHY
 *   Before the well_type-aware classification fix (commit 3bff7a9), the ND
 *   refresh classified by status alone (A -> wells), so it wrote disposal- and
 *   other-typed wells (SWD/WI/GASD/WS/CONFIDENTIAL/...) into `wells` and
 *   `wells_inactive`. Those should never have been there — the catalog layout is
 *   wells = OG-active, wells_inactive = OG-inactive, disposals = SWD/WI-active.
 *   They now surface in WB T's well picker. This script removes exactly those
 *   mis-filed docs.
 *
 * SCOPE — deletes a doc ONLY when ALL of these hold:
 *   - collection is `wells` or `wells_inactive`
 *   - state === 'ND'
 *   - well_type is present AND !== 'OG'
 *   Anything missing state, missing well_type, OG, MT, or in any other
 *   collection is left untouched (defensive: never delete the discriminator-less).
 *
 * SAFETY
 *   - DRY-RUN BY DEFAULT. Deletes ONLY with explicit `--write` (and not
 *     `--dry-run`). No flag => dry-run.
 *   - Touches ONLY `wells` and `wells_inactive`. Never `disposals`, OG wells,
 *     MT docs, well_config (RTDB), customLocations, swd_directory, or any
 *     dispatch/job/ticket/invoice data.
 *   - Batched deletes (<=500). Lists counts by collection + well_type and sample
 *     docs before any delete.
 *
 * USAGE (from wellbuilt-dashboard/)
 *   node scripts/cleanup-well-catalog-pollution.js            # dry-run (default)
 *   node scripts/cleanup-well-catalog-pollution.js --write    # apply deletes
 */

'use strict';

let admin;
try { admin = require('firebase-admin'); }
catch (_e) { admin = require('../functions/node_modules/firebase-admin'); }
const svc = require('../serviceAccountKey.json');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write') && !argv.includes('--dry-run');

const COLLECTIONS = ['wells', 'wells_inactive'];

function isPollution(d) {
  const state = d && typeof d.state === 'string' ? d.state.trim().toUpperCase() : '';
  const wt = d && typeof d.well_type === 'string' ? d.well_type.trim().toUpperCase() : '';
  return state === 'ND' && wt !== '' && wt !== 'OG';
}

function tally(arr, keyFn) {
  const m = {};
  for (const x of arr) { const k = keyFn(x); m[k] = (m[k] || 0) + 1; }
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}

async function main() {
  const started = Date.now();
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  const db = admin.firestore();

  console.log('='.repeat(70));
  console.log(`WB catalog pollution cleanup  |  mode=${WRITE ? 'WRITE (DELETE)' : 'DRY-RUN'}`);
  console.log(`Criteria: collection in [wells, wells_inactive] AND state==='ND' AND well_type!=='OG'`);
  console.log('='.repeat(70));

  let grandTotal = 0;
  for (const coll of COLLECTIONS) {
    const snap = await db.collection(coll).get();
    const victims = [];
    snap.forEach((d) => { const data = d.data(); if (isPollution(data)) victims.push({ id: d.id, ...data }); });

    console.log(`\n[${coll}] scanned ${snap.size} docs → ${victims.length} match the deletion criteria`);
    console.log(`   by well_type:`, JSON.stringify(tally(victims, (v) => v.well_type)));
    console.log(`   sample (up to 6):`);
    for (const v of victims.slice(0, 6)) {
      console.log(`     ${v.id}  ${v.well_name}  type=${v.well_type} status=${v.status} state=${v.state}`);
    }
    grandTotal += victims.length;

    if (WRITE && victims.length) {
      console.log(`   DELETING ${victims.length} docs (batched <=500)...`);
      for (let i = 0; i < victims.length; i += 500) {
        const batch = db.batch();
        for (const v of victims.slice(i, i + 500)) {
          batch.delete(db.collection(coll).doc(v.id));
        }
        await batch.commit();
        console.log(`     deleted ${Math.min(i + 500, victims.length)}/${victims.length}`);
      }
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(70));
  console.log(`${WRITE ? 'DELETED' : 'WOULD DELETE'} ${grandTotal} docs total across wells + wells_inactive.  elapsed ${secs}s`);
  console.log(`disposals + OG wells + MT + all other collections: UNTOUCHED.`);
  if (!WRITE) console.log(`\nRe-run with --write (and without --dry-run) to delete, after review.`);
  console.log('='.repeat(70));
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
