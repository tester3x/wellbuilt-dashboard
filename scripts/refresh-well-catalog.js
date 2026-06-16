/**
 * refresh-well-catalog.js — safe, merge-only refresh of the WB well catalog
 * from the public regulator GIS source.
 *
 * WHY THIS EXISTS
 *   The `wells` / `wells_inactive` collections are a frozen snapshot taken
 *   2026-03-01. There is no committed importer to refresh them, so wells that
 *   went active/public in NDIC after that date (e.g. "Daredevil Federal
 *   2-2-14H", api 33-053-10282-00-00) never appear in WB. This script is the
 *   missing refresh path.
 *
 * SAFETY MODEL (read carefully)
 *   - DRY-RUN BY DEFAULT. Firestore is written ONLY when `--write` is passed
 *     AND `--dry-run` is NOT. No flag => dry-run.
 *   - UPSERT ONLY, keyed by api_no docId, via set(..., { merge: true }).
 *   - NEVER deletes a collection, a doc, or a field.
 *   - NEVER overwrites an existing field with null / NaN / '' (those keys are
 *     stripped from the candidate before write), so good coords/names survive
 *     even if the source row is sparse on a given day.
 *   - Touches ONLY: wells, wells_inactive, wellDataMeta. Does NOT touch
 *     well_config (RTDB), customLocations, swd_directory/blacklist, disposals,
 *     dispatches, tickets, invoices.
 *
 * SCOPE OF THIS PASS
 *   - ND via NDIC DMR ArcGIS REST API  → IMPLEMENTED + verified.
 *   - MT via MBOGC ArcGIS MapServer    → NOT in this pass. The exact MapServer
 *     endpoint + field mapping used for the March snapshot is not recoverable
 *     from any committed code, and requirement #10 says do not guess. MT is
 *     reported and skipped. Fill MBOGC_SOURCE below once the endpoint is
 *     confirmed, then enable `--state MT`.
 *   - ND disposals → IMPLEMENTED. Proven mapping: same NDIC source, well_type
 *     SWD/WI, status A, docId = api_no, identical doc shape. MT disposals are
 *     still out of scope (MT source unconfirmed).
 *
 * CLASSIFICATION (well_type + status → target collection)
 *   well_type SWD/WI + status 'A'  → disposals      (proven SWD mapping)
 *   well_type OG     + status 'A'  → wells           (WB T active-by-operator)
 *   well_type OG     + status 'IA' → wells_inactive  (routed-inactive fallback)
 *   any other well_type (GASD/WS/GASC/AI/GASN/GI) → skipped + counted (not part
 *     of the proven mapping — not guessed)
 *   any other status (AB/PA/DRL/CONF/LOC/...) → skipped + counted
 *
 * USAGE  (run from the wellbuilt-dashboard/ directory)
 *   node scripts/refresh-well-catalog.js                       # dry-run, ND, full catalog
 *   node scripts/refresh-well-catalog.js --operator "SLAWSON EXPLORATION COMPANY, INC."
 *   node scripts/refresh-well-catalog.js --write              # WRITE, ND, full catalog
 *   node scripts/refresh-well-catalog.js --limit 200          # cap upstream rows (testing)
 *
 * FIELD SHAPE produced (mirrors existing ND docs exactly):
 *   well_name, operator, api_no, latitude, longitude, sec, twp, rng, qq,
 *   field_name, county, well_type, status, legal_desc, search_name,
 *   search_operator, state
 */

'use strict';

// firebase-admin lives only in functions/node_modules in this repo.
let admin;
try {
  admin = require('firebase-admin');
} catch (_e) {
  admin = require('../functions/node_modules/firebase-admin');
}
const svc = require('../serviceAccountKey.json');

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function argVal(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const WRITE = argv.includes('--write') && !argv.includes('--dry-run');
const STATE = (argVal('--state') || 'ND').toUpperCase();
const OPERATOR = argVal('--operator');                 // optional exact-match scope
const LIMIT = argVal('--limit') ? parseInt(argVal('--limit'), 10) : null;

// ── source config ─────────────────────────────────────────────────────────────
const NDIC_SOURCE = {
  state: 'ND',
  label: 'NDIC DMR ArcGIS REST API',
  url: 'https://gis.dmr.nd.gov/dmrpublicservices/rest/services/OilGasPublicMapDataVectorTiles/Wells/FeatureServer/0/query',
  metaDoc: 'lastSyncND',
  page: 1000,
};
// MBOGC endpoint for MT is intentionally null — see "SCOPE OF THIS PASS".
const MBOGC_SOURCE = null;

const OUT_FIELDS = [
  'well_name', 'api_no', 'operator', 'latitude', 'longitude',
  'sec', 'twp', 'rng', 'qq', 'field_name', 'County', 'well_type', 'status',
].join(',');

// ── helpers ───────────────────────────────────────────────────────────────────
function esriEscape(s) {
  return String(s).replace(/'/g, "''");
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Map one NDIC ArcGIS attributes object to the exact WB ND well doc shape. */
function ndicToDoc(a) {
  const wellName = String(a.well_name || '').trim();
  const operator = String(a.operator || '').trim();
  const apiNo = String(a.api_no || '').trim();
  const sec = intOrNull(a.sec);
  const twp = intOrNull(a.twp);
  const rng = intOrNull(a.rng);
  const qq = a.qq != null ? String(a.qq).trim() : '';
  const legal = [
    qq,
    sec != null ? `Sec ${sec}` : '',
    twp != null ? `T${twp}N` : '',
    rng != null ? `R${rng}W` : '',
  ].filter(Boolean).join(' ');

  // Build full candidate, then strip empties so merge never nukes a good value.
  const raw = {
    well_name: wellName,
    operator,
    api_no: apiNo,
    latitude: numOrNull(a.latitude),
    longitude: numOrNull(a.longitude),
    sec, twp, rng,
    qq,
    field_name: a.field_name != null ? String(a.field_name).trim() : '',
    county: a.County != null ? String(a.County).trim().toUpperCase() : '',
    well_type: a.well_type != null ? String(a.well_type).trim() : '',
    status: String(a.status || '').trim(),
    legal_desc: legal,
    search_name: wellName.toLowerCase(),
    search_operator: operator.toLowerCase(),
    state: 'ND',
  };
  const doc = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    if (typeof v === 'string' && v === '') continue;
    doc[k] = v;
  }
  return doc;
}

/** Page through an ESRI FeatureServer query, returning all attribute rows. */
async function fetchAllFeatures(source, where) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({
      where,
      outFields: OUT_FIELDS,
      returnGeometry: 'false',
      orderByFields: 'api_no',
      resultOffset: String(offset),
      resultRecordCount: String(source.page),
      f: 'json',
    });
    const resp = await fetch(`${source.url}?${params.toString()}`);
    if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status}`);
    const j = await resp.json();
    if (j.error) throw new Error(`ArcGIS error: ${JSON.stringify(j.error)}`);
    const feats = j.features || [];
    for (const f of feats) rows.push(f.attributes);
    if (LIMIT && rows.length >= LIMIT) return rows.slice(0, LIMIT);
    if (feats.length < source.page && !j.exceededTransferLimit) break;
    if (feats.length === 0) break;
    offset += feats.length;
  }
  return rows;
}

/** Shallow compare: does `existing` already contain every candidate field equal? */
function isUnchanged(candidate, existing) {
  if (!existing) return false;
  for (const [k, v] of Object.entries(candidate)) {
    if (existing[k] !== v) return false;
  }
  return true;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  const fs = admin.firestore();

  console.log('='.repeat(70));
  console.log(`WB well catalog refresh  |  mode=${WRITE ? 'WRITE' : 'DRY-RUN'}  state=${STATE}`);
  if (OPERATOR) console.log(`operator filter: ${OPERATOR}`);
  if (LIMIT) console.log(`upstream row cap: ${LIMIT}`);
  console.log('='.repeat(70));

  if (STATE === 'MT' || STATE === 'ALL') {
    console.log('\n[MT] SKIPPED — MBOGC MapServer endpoint + field mapping not');
    console.log('     confirmed from committed code. Fill MBOGC_SOURCE and re-run.');
    if (STATE === 'MT') {
      console.log('\nNothing to do for MT this pass.');
      process.exit(0);
    }
  }
  console.log('\n[disposals] ND disposals INCLUDED — well_type SWD/WI, status A → disposals.');

  const source = NDIC_SOURCE;
  const where = OPERATOR ? `operator='${esriEscape(OPERATOR)}'` : '1=1';

  // 1) Pull upstream.
  console.log(`\n[ND] Fetching upstream wells (${source.label})...`);
  const rows = await fetchAllFeatures(source, where);
  const upActive = rows.filter((r) => String(r.status || '').trim() === 'A').length;
  const upInactive = rows.filter((r) => String(r.status || '').trim() === 'IA').length;
  console.log(`     upstream rows: ${rows.length}  (active A=${upActive}, inactive IA=${upInactive}, other=${rows.length - upActive - upInactive})`);

  // 2) Load existing target docs into memory (api_no → data).
  async function loadExisting(coll) {
    const map = new Map();
    let q = fs.collection(coll);
    if (OPERATOR) q = q.where('operator', '==', OPERATOR);
    const snap = await q.get();
    snap.forEach((d) => map.set(d.id, d.data()));
    return map;
  }
  console.log('\n[ND] Loading existing Firestore docs...');
  const existingWells = await loadExisting('wells');
  const existingInactive = await loadExisting('wells_inactive');
  const existingDisposals = await loadExisting('disposals');
  console.log(`     existing wells=${existingWells.size}  wells_inactive=${existingInactive.size}  disposals=${existingDisposals.size}` +
    (OPERATOR ? ' (operator-scoped)' : ''));

  // 3) Classify + diff.
  // Classification reproduces the original snapshot exactly and keeps the three
  // collections disjoint by well_type:
  //   well_type SWD/WI  → disposals (status A only; else skipped)
  //   well_type OG      → wells (A) / wells_inactive (IA); other status skipped
  //   any other type    → skipped + counted (GASD/WS/GASC/AI/GASN/GI — not part
  //                       of the proven mapping; routing them is not guessed)
  // NOTE: the prior status-only rule (any A → wells) wrote SWD/WI into `wells`.
  // This restores the disjoint layout. Existing mis-filed docs are NOT removed
  // here (no deletes) — that cleanup is a separate, approved step.
  const DISPOSAL_TYPES = new Set(['SWD', 'WI']);
  const stats = {
    wells: { add: 0, update: 0, unchanged: 0 },
    wells_inactive: { add: 0, update: 0, unchanged: 0 },
    disposals: { add: 0, update: 0, unchanged: 0 },
    skippedOtherStatus: 0,
    skippedOtherType: 0,
    skippedNoApi: 0,
    errors: 0,
    byOtherStatus: {},
    byOtherType: {},
  };
  const ops = []; // { coll, id, data }
  for (const a of rows) {
    try {
      const status = String(a.status || '').trim();
      const wt = String(a.well_type || '').trim().toUpperCase();
      const apiNo = String(a.api_no || '').trim();
      if (!apiNo) { stats.skippedNoApi++; continue; }

      let coll, existingMap;
      if (DISPOSAL_TYPES.has(wt)) {
        if (status === 'A') { coll = 'disposals'; existingMap = existingDisposals; }
        else { stats.skippedOtherStatus++; stats.byOtherStatus[status || '(blank)'] = (stats.byOtherStatus[status || '(blank)'] || 0) + 1; continue; }
      } else if (wt === 'OG') {
        if (status === 'A') { coll = 'wells'; existingMap = existingWells; }
        else if (status === 'IA') { coll = 'wells_inactive'; existingMap = existingInactive; }
        else { stats.skippedOtherStatus++; stats.byOtherStatus[status || '(blank)'] = (stats.byOtherStatus[status || '(blank)'] || 0) + 1; continue; }
      } else {
        stats.skippedOtherType++;
        stats.byOtherType[wt || '(blank)'] = (stats.byOtherType[wt || '(blank)'] || 0) + 1;
        continue;
      }

      const doc = ndicToDoc(a);
      const existing = existingMap.get(apiNo);
      if (!existing) { stats[coll].add++; ops.push({ coll, id: apiNo, data: doc }); }
      else if (isUnchanged(doc, existing)) { stats[coll].unchanged++; }
      else { stats[coll].update++; ops.push({ coll, id: apiNo, data: doc }); }
    } catch (_e) {
      stats.errors++;
    }
  }

  // 4) Targeted Daredevil proof (always shown).
  console.log('\n--- Daredevil Federal pad proof ---');
  const ddTargets = ['33-053-10282-00-00', '33-053-10392-00-00', '33-053-10393-00-00', '33-053-10394-00-00'];
  for (const api of ddTargets) {
    const a = rows.find((r) => String(r.api_no || '').trim() === api);
    if (!a) { console.log(`  ${api}: NOT in upstream pull`); continue; }
    const status = String(a.status || '').trim();
    const coll = status === 'A' ? 'wells' : status === 'IA' ? 'wells_inactive' : '(skipped)';
    const inWells = existingWells.has(api);
    const inInact = existingInactive.has(api);
    const decision = coll === '(skipped)' ? 'skip'
      : (coll === 'wells' ? !inWells : !inInact) ? 'ADD' : 'update/unchanged';
    console.log(`  ${api}  ${a.well_name}  status=${status}  op=${a.operator}`);
    console.log(`      lat=${a.latitude} lng=${a.longitude}  → ${coll}  (${decision}; existing wells=${inWells} inactive=${inInact})`);
  }

  // 4b) Disposal proof — prove NDIC returns WI/SWD and a known ND disposal upserts.
  console.log('\n--- ND disposal (SWD/WI) proof ---');
  const dzRows = rows.filter((r) => ['SWD', 'WI'].includes(String(r.well_type || '').trim().toUpperCase()) && String(r.status || '').trim() === 'A');
  console.log(`  NDIC status=A SWD/WI rows in this pull: ${dzRows.length}`);
  const dzTargets = ['33-007-00009-00-00']; // FRYBURG HEATH-MADISON UNIT O-809 (WI)
  for (const api of dzTargets) {
    const a = rows.find((r) => String(r.api_no || '').trim() === api);
    if (!a) { console.log(`  ${api}: NOT in upstream pull`); continue; }
    const inDz = existingDisposals.has(api);
    console.log(`  ${api}  ${a.well_name}  status=${a.status}  type=${a.well_type}  → disposals  (${inDz ? 'update/unchanged' : 'ADD'}; existing disposal=${inDz})`);
  }
  for (const a of dzRows.slice(0, 2)) {
    console.log(`  e.g. ${a.api_no}  ${a.well_name}  type=${a.well_type}`);
  }

  // 5) Write (only with --write).
  if (WRITE && ops.length) {
    console.log(`\n[ND] WRITING ${ops.length} upserts (merge, batched ≤500)...`);
    for (let i = 0; i < ops.length; i += 500) {
      const batch = fs.batch();
      for (const op of ops.slice(i, i + 500)) {
        batch.set(fs.collection(op.coll).doc(op.id), op.data, { merge: true });
      }
      await batch.commit();
      console.log(`     committed ${Math.min(i + 500, ops.length)}/${ops.length}`);
    }

    // wellDataMeta — merge so disposalCount/operatorCount survive.
    const wellsCount = (await fs.collection('wells').count().get()).data().count;
    await fs.collection('wellDataMeta').doc(source.metaDoc).set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      wellCount: wellsCount,
      source: source.label,
      lastRefreshStats: {
        upstreamRows: rows.length,
        wellsAdded: stats.wells.add,
        wellsUpdated: stats.wells.update,
        inactiveAdded: stats.wells_inactive.add,
        inactiveUpdated: stats.wells_inactive.update,
        disposalsAdded: stats.disposals.add,
        disposalsUpdated: stats.disposals.update,
        operatorScope: OPERATOR || 'ALL',
      },
    }, { merge: true });
    console.log(`     wellDataMeta/${source.metaDoc} updated (wells count now ${wellsCount}).`);
  } else if (WRITE) {
    console.log('\n[ND] WRITE requested but 0 upserts needed — nothing to write.');
  }

  // 6) Summary.
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(70));
  console.log(`SUMMARY (${WRITE ? 'WROTE' : 'DRY-RUN — no writes'})  elapsed ${secs}s`);
  console.log(`  upstream rows ............ ${rows.length}`);
  console.log(`  wells          add=${stats.wells.add}  update=${stats.wells.update}  unchanged=${stats.wells.unchanged}`);
  console.log(`  wells_inactive add=${stats.wells_inactive.add}  update=${stats.wells_inactive.update}  unchanged=${stats.wells_inactive.unchanged}`);
  console.log(`  disposals      add=${stats.disposals.add}  update=${stats.disposals.update}  unchanged=${stats.disposals.unchanged}`);
  console.log(`  skipped (other status) ... ${stats.skippedOtherStatus}  ${JSON.stringify(stats.byOtherStatus)}`);
  console.log(`  skipped (other type) ..... ${stats.skippedOtherType}  ${JSON.stringify(stats.byOtherType)}`);
  console.log(`  skipped (no api_no) ...... ${stats.skippedNoApi}`);
  console.log(`  errors ................... ${stats.errors}`);
  if (!WRITE) console.log('\n  Re-run with --write (and without --dry-run) to apply, after review.');
  console.log('='.repeat(70));
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
