#!/usr/bin/env node
// canonical_jobs read-only validation report.
//
// Surveys recent packets / tickets / transfer_requests and reports which
// have a corresponding canonical_jobs row. NO WRITES.
//
// Usage:
//   node functions/scripts/validate-canonical-jobs.mjs [--limit=100] [--json]
//
// Requires GOOGLE_APPLICATION_CREDENTIALS or running in an environment with
// implicit Admin SDK creds (gcloud auth application-default login).

import process from 'node:process';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';

const argv = process.argv.slice(2);
const LIMIT = (() => {
  const arg = argv.find((a) => a.startsWith('--limit='));
  if (!arg) return 100;
  const n = parseInt(arg.split('=')[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 100;
})();
const JSON_OUT = argv.includes('--json');

if (!getApps().length) {
  initializeApp({
    credential: applicationDefault(),
    databaseURL: 'https://wellbuilt-sync-default-rtdb.firebaseio.com',
  });
}
const db = getFirestore();
const rtdb = getDatabase();

function fmtBool(v) {
  return v ? 'YES' : 'no ';
}

async function checkPacket(packetId, packet) {
  const cj = await db.collection('canonical_jobs').doc(packetId).get();
  return {
    entityType: 'packet',
    id: packetId,
    hasCanonicalRow: cj.exists,
    packetIdLinked: cj.exists ? cj.get('packetId') === packetId : false,
    ticketNumberLinked: cj.exists && !!cj.get('ticketNumber'),
    transferRequestIdLinked: cj.exists && !!cj.get('transferRequestId'),
    companyIdPresent: cj.exists && !!cj.get('companyId'),
    driverHashPresent: cj.exists && !!cj.get('driverHash'),
    wellName: packet.wellName ?? null,
  };
}

async function checkTicket(ticketDoc) {
  const data = ticketDoc.data();
  const packetId = data.packetId || null;
  if (!packetId) {
    return {
      entityType: 'ticket',
      id: ticketDoc.id,
      hasCanonicalRow: 'unknown (no packetId; would be auto-id)',
      packetIdLinked: false,
      ticketNumberLinked: false,
      transferRequestIdLinked: false,
      companyIdPresent: false,
      driverHashPresent: false,
      ticketNumber: data.ticketNumber || null,
    };
  }
  const cj = await db.collection('canonical_jobs').doc(packetId).get();
  return {
    entityType: 'ticket',
    id: ticketDoc.id,
    hasCanonicalRow: cj.exists,
    packetIdLinked: cj.exists ? cj.get('packetId') === packetId : false,
    ticketNumberLinked: cj.exists ? cj.get('ticketNumber') === data.ticketNumber : false,
    transferRequestIdLinked: cj.exists && !!cj.get('transferRequestId'),
    companyIdPresent: cj.exists && !!cj.get('companyId'),
    driverHashPresent: cj.exists && !!cj.get('driverHash'),
    ticketNumber: data.ticketNumber || null,
  };
}

async function checkTransfer(reqDoc) {
  const data = reqDoc.data();
  const sourceInvoiceDocId = data.sourceInvoiceDocId || null;
  let packetId = data.sourcePacketId || data.packetId || null;
  if (!packetId && sourceInvoiceDocId) {
    const inv = await db.collection('invoices').doc(sourceInvoiceDocId).get();
    if (inv.exists) packetId = inv.get('packetId') || null;
  }
  if (!packetId) {
    return {
      entityType: 'transfer_request',
      id: reqDoc.id,
      hasCanonicalRow: 'unknown (no packetId resolvable)',
      packetIdLinked: false,
      ticketNumberLinked: false,
      transferRequestIdLinked: false,
      companyIdPresent: false,
      driverHashPresent: false,
    };
  }
  const cj = await db.collection('canonical_jobs').doc(packetId).get();
  return {
    entityType: 'transfer_request',
    id: reqDoc.id,
    hasCanonicalRow: cj.exists,
    packetIdLinked: cj.exists ? cj.get('packetId') === packetId : false,
    ticketNumberLinked: cj.exists && !!cj.get('ticketNumber'),
    transferRequestIdLinked:
      cj.exists ? cj.get('transferRequestId') === reqDoc.id : false,
    companyIdPresent: cj.exists && !!cj.get('companyId'),
    driverHashPresent: cj.exists && !!cj.get('driverHash'),
  };
}

// Real pull-packet keys are stamped YYYYMMDD_HHMMSS_WellName_suffix
// (e.g. 20260510_012451_Gabriel1_qfrcvk). Other entries can land in
// packets/processed too — notably delete_* / edit_* / fault records — and
// since 'd' (0x64) and 'e' (0x65) sort AFTER digits ('0'-'9' = 0x30-0x39),
// a naive limitToLast on the raw ref is biased toward those non-pull keys.
// We restrict the query to digit-prefixed keys server-side.
const REAL_PACKET_KEY_RE = /^\d{8}_\d{6}_/;

async function fetchRecentRealPackets(limit) {
  // Strategy: fetch the full packets/processed listing, filter to real
  // pull-packet keys, sort by key descending (chronological), take top N.
  //
  // Why not orderByKey().startAt('0').endAt(':').limitToLast(N)?
  //   Empirically returns only 1 entry against this dataset — the RTDB
  //   range+limitToLast combination behaves unreliably across SDK
  //   versions and dataset shapes.
  //
  // Why not orderByChild('processedAt').limitToLast(N)?
  //   delete_* and edit_* records also carry processedAt, and recent
  //   delete/edit activity dominates the top-N window, masking real
  //   pull packets.
  //
  // Cost: 3000–10000 entries scanned client-side. Trivial for an admin
  // script and acceptable for the read-only validation use case.
  const snap = await rtdb.ref('packets/processed').once('value');

  const realEntries = [];
  snap.forEach((c) => {
    if (REAL_PACKET_KEY_RE.test(c.key)) {
      realEntries.push([c.key, c.val()]);
    }
  });

  // Most-recent-first by key (YYYYMMDD_HHMMSS prefix sorts chronologically).
  realEntries.sort((a, b) => (b[0] < a[0] ? -1 : b[0] > a[0] ? 1 : 0));

  return realEntries.slice(0, limit);
}

async function main() {
  const rows = [];

  // Recent real pull packets — see fetchRecentRealPackets header for why
  // limitToLast on the raw ref is biased toward delete_* keys.
  const packetEntries = await fetchRecentRealPackets(LIMIT);
  for (const [pid, pkt] of packetEntries) {
    rows.push(await checkPacket(pid, pkt || {}));
  }

  // Recent tickets
  const ticketsSnap = await db
    .collection('tickets')
    .orderBy('createdAt', 'desc')
    .limit(LIMIT)
    .get();
  for (const t of ticketsSnap.docs) {
    rows.push(await checkTicket(t));
  }

  // Recent transfer_requests
  let transfersSnap;
  try {
    transfersSnap = await db
      .collection('transfer_requests')
      .orderBy('createdAt', 'desc')
      .limit(LIMIT)
      .get();
  } catch {
    transfersSnap = await db.collection('transfer_requests').limit(LIMIT).get();
  }
  for (const r of transfersSnap.docs) {
    rows.push(await checkTransfer(r));
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  // Summary table
  const totals = {
    packet: { total: 0, hasRow: 0 },
    ticket: { total: 0, hasRow: 0 },
    transfer_request: { total: 0, hasRow: 0 },
  };
  for (const r of rows) {
    const k = r.entityType;
    totals[k].total++;
    if (r.hasCanonicalRow === true) totals[k].hasRow++;
  }
  console.log('canonical_jobs validation — summary');
  console.log('───────────────────────────────────────────');
  for (const [type, t] of Object.entries(totals)) {
    const pct = t.total === 0 ? 0 : ((t.hasRow / t.total) * 100).toFixed(1);
    console.log(`  ${type.padEnd(18)} ${t.hasRow}/${t.total} have canonical row (${pct}%)`);
  }
  console.log('');
  console.log('first 20 rows:');
  console.log(
    [
      'entity'.padEnd(18),
      'id'.padEnd(28),
      'row',
      'pkt',
      'tk#',
      'trf',
      'co ',
      'drv',
    ].join(' '),
  );
  for (const r of rows.slice(0, 20)) {
    console.log(
      [
        r.entityType.padEnd(18),
        String(r.id).slice(0, 28).padEnd(28),
        fmtBool(r.hasCanonicalRow === true),
        fmtBool(r.packetIdLinked),
        fmtBool(r.ticketNumberLinked),
        fmtBool(r.transferRequestIdLinked),
        fmtBool(r.companyIdPresent),
        fmtBool(r.driverHashPresent),
      ].join(' '),
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('validate-canonical-jobs failed:', err?.message || err);
    process.exit(1);
  });
