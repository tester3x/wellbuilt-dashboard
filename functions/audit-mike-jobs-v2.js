/**
 * Full cross-store audit for Mike's 2026-07-05 single-load jobs.
 * Uses Firebase CLI refresh token from configstore for authenticated reads.
 */
const fs = require('fs');
const path = require('path');

const PROJECT = 'wellbuilt-sync';
const RTDB = 'https://wellbuilt-sync-default-rtdb.firebaseio.com';
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const JOBS = [
  {
    label: '19064',
    ticket: '19064',
    invoiceDocId: 'kt55zF0JIiKRy0gz7Ywp',
    dispatchId: 'eSf9PwSiWTgapf6GyNAj',
    packetId: '20260705_092317_Gabriel5_sleu27',
    ticketDocId: 'DdFNgeW8yC1J6GjPmq2y',
    wellFull: 'GABRIEL 5-36-25TFH',
    wellShort: 'Gabriel 5',
    packetTs: '20260705_092317',
    pullDate: '2026-07-05',
  },
  {
    label: '19065',
    ticket: '19065',
    invoiceDocId: 'p6Bojd25U5wXQOIsu8nh',
    dispatchId: 'Ljogsun7Jin5riEoas4n',
    packetId: '20260705_105631_Thor1_ate2l2',
    ticketDocId: 'a33GWmidkpJpytAWCRsw',
    wellFull: 'THOR  1-31-30H',
    wellShort: 'Thor 1',
    packetTs: '20260705_105631',
    pullDate: '2026-07-05',
  },
];

function loadFirebaseToken() {
  const cfgPath = path.join(
    process.env.USERPROFILE || process.env.HOME,
    '.config',
    'configstore',
    'firebase-tools.json',
  );
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  return cfg.tokens?.access_token || null;
}

async function refreshTokenIfNeeded() {
  const cfgPath = path.join(
    process.env.USERPROFILE || process.env.HOME,
    '.config',
    'configstore',
    'firebase-tools.json',
  );
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const now = Date.now();
  if (cfg.tokens?.expires_at && cfg.tokens.expires_at > now + 60000) {
    return cfg.tokens.access_token;
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
      client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
      refresh_token: cfg.tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  cfg.tokens.access_token = data.access_token;
  cfg.tokens.expires_at = Date.now() + data.expires_in * 1000;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, '\t'));
  return data.access_token;
}

function parseValue(v) {
  if (!v || typeof v !== 'object') return v;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.nullValue !== undefined) return null;
  if (v.arrayValue) return (v.arrayValue.values || []).map(parseValue);
  if (v.mapValue) {
    const m = {};
    for (const [k, mv] of Object.entries(v.mapValue.fields || {})) m[k] = parseValue(mv);
    return m;
  }
  return v;
}

function parseDoc(doc) {
  if (!doc?.fields) return null;
  const out = { _id: doc.name.split('/').pop() };
  for (const [k, v] of Object.entries(doc.fields)) out[k] = parseValue(v);
  return out;
}

async function getFirestoreDoc(collection, id, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${FIRESTORE}/${collection}/${id}`, { headers });
  if (res.status === 404) return { status: 404, data: null };
  if (res.status === 403) return { status: 403, data: null };
  const data = await res.json();
  if (!res.ok) return { status: res.status, data, error: true };
  return { status: 200, data: parseDoc(data) };
}

async function getRtdb(pathSuffix) {
  const res = await fetch(`${RTDB}/${pathSuffix}.json`);
  if (!res.ok) return null;
  return res.json();
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function analyzeDriveMiles(invoice, job) {
  const tl = invoice?.timeline || [];
  const stored = {
    invoice_driveDistanceMiles: invoice?.driveDistanceMiles ?? null,
    invoice_driveMiles: invoice?.driveMiles ?? null,
  };

  // FlowController accumulates on arrive from last 'depart' event only
  let simulated = 0;
  for (let i = 0; i < tl.length; i++) {
    const ev = tl[i];
    if (ev.type !== 'arrive' || !ev.lat || !ev.lng) continue;
    const depart = [...tl.slice(0, i)].reverse().find((e) => e.type === 'depart');
    if (depart?.lat && depart?.lng) {
      const meters =
        haversineMiles(depart.lat, depart.lng, ev.lat, ev.lng) * 1609.344;
      simulated += Math.round((meters * 1.3) / 1609.344 * 10) / 10;
    }
  }

  // Dashboard driverLogs: sum GPS segments between depart/arrive pairs in timeline
  let timelineGpsMiles = 0;
  for (let i = 1; i < tl.length; i++) {
    const prev = tl[i - 1];
    const cur = tl[i];
    if (
      (prev.type === 'depart' || prev.type === 'depart_site') &&
      cur.type === 'arrive' &&
      prev.lat && prev.lng && cur.lat && cur.lng
    ) {
      timelineGpsMiles += haversineMiles(prev.lat, prev.lng, cur.lat, cur.lng);
    }
  }
  timelineGpsMiles = Math.round(timelineGpsMiles * 10) / 10;

  return { ...stored, flowControllerSimulated: simulated, dashboardTimelineGps: timelineGpsMiles };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k] ?? null;
  return out;
}

(async () => {
  let token;
  try {
    token = await refreshTokenIfNeeded();
    console.log('AUTH: Firebase CLI token OK (canonical_jobs readable)\n');
  } catch (e) {
    console.log('AUTH: token refresh failed, falling back to public reads\n');
  }

  for (const job of JOBS) {
    console.log('\n' + '='.repeat(78));
    console.log(`TICKET ${job.label}`);
    console.log('='.repeat(78));

    const invR = await getFirestoreDoc('invoices', job.invoiceDocId, token);
    const tktR = await getFirestoreDoc('tickets', job.ticketDocId, token);
    const dispR = await getFirestoreDoc('dispatches', job.dispatchId, token);
    const canR = await getFirestoreDoc('canonical_jobs', job.packetId, token);

    const invoice = invR.data;
    const ticket = tktR.data;
    const dispatch = dispR.data;
    const canonical = canR.data;

    console.log('\n--- Identity ---');
    console.log(JSON.stringify({
      ticketNumber: job.ticket,
      invoiceDocId: job.invoiceDocId,
      dispatchId: job.dispatchId,
      packetId: job.packetId,
      ticketDocId: job.ticketDocId,
      canonical_read_status: canR.status,
      canonical_exists: !!canonical,
    }, null, 2));

    console.log('\n--- ticket.invoiceDocId / driverStage ---');
    console.log(JSON.stringify({
      ticket_invoiceDocId: ticket?.invoiceDocId ?? '(missing)',
      ticket_dispatchId: ticket?.dispatchId,
      ticket_packetId: ticket?.packetId,
      dispatch_status: dispatch?.status,
      dispatch_driverStage: dispatch?.driverStage,
      dispatch_completedAt: dispatch?.completedAt,
    }, null, 2));

    console.log('\n--- driveMiles / driveDistanceMiles ---');
    const dm = analyzeDriveMiles(invoice, job);
    console.log(JSON.stringify({
      ...dm,
      ticket_driveMiles: ticket?.driveMiles ?? null,
      dispatch_driveMiles: dispatch?.driveMiles ?? null,
      dispatch_driveDistanceMiles: dispatch?.driveDistanceMiles ?? null,
    }, null, 2));

    console.log('\n--- BBL chain ---');
    const procPkt = await getRtdb(`packets/processed/${job.packetId}`);
    console.log(JSON.stringify({
      invoice_totalBBL: invoice?.totalBBL,
      ticket_bbls: ticket?.bbls,
      ticket_qty: ticket?.qty,
      summary_qty: invoice?.ticketSummaries?.[0]?.qty,
      dispatch_totalBBL: dispatch?.totalBBL,
      packet_bblsTaken: procPkt?.bblsTaken,
      canonical_bblsTaken: canonical?.bblsTaken,
    }, null, 2));

    console.log('\n--- Canonical job (direct read) ---');
    if (canonical) {
      console.log(JSON.stringify(pick(canonical, [
        'packetId', 'invoiceDocId', 'dispatchId', 'ticketDocId', 'ticketNumber',
        'companyId', 'driverHash', 'driverName', 'wellName', 'wellConfigKey',
        'bblsTaken', 'status', 'source', 'createdAt', 'updatedAt',
      ]), null, 2));
      const events = canonical.events || [];
      console.log(`  events: ${events.length}`);
      events.slice(-6).forEach((e, i) =>
        console.log(`    ${i + 1}. ${e.type || e.event} @ ${e.at || e.timestamp}`),
      );
    } else {
      console.log(`  NOT READABLE (status ${canR.status})`);
    }

    console.log('\n--- Timeline ---');
    (invoice?.timeline || []).forEach((e, i) =>
      console.log(`  ${i + 1}. ${e.type} @ ${e.timestamp} loc=${e.locationName} lat=${e.lat} lng=${e.lng}`),
    );

    console.log('\n--- RTDB packet ---');
    console.log(JSON.stringify(pick(procPkt, [
      'packetId', 'requestType', 'jobOrigin', 'wellName', 'bblsTaken',
      'invoiceDocId', 'dispatchId', 'tankLevelFeet', 'isEdit', 'originalPacketId',
    ]), null, 2));

    // WB-M stores — try multiple well key variants
    const wellVariants = [
      job.wellShort,
      job.wellFull,
      job.wellShort.replace(/\s+/g, '_'),
      job.wellFull.replace(/\s+/g, '_'),
    ];
    const uniqueVariants = [...new Set(wellVariants)];

    console.log('\n--- WB-M RTDB: wells/status ---');
    for (const w of uniqueVariants) {
      const status = await getRtdb(`wells/${w}/status`);
      if (status) {
        console.log(`  FOUND wells/${w}/status`);
        console.log(JSON.stringify({
          lastPull_packetId: status?.lastPull?.packetId,
          lastPull_bblsTaken: status?.lastPull?.bblsTaken,
          lastPull_dateTimeUTC: status?.lastPull?.dateTimeUTC,
          current_level: status?.current?.level,
          updatedAt: status?.updatedAt,
        }, null, 2));
      }
    }

    console.log('\n--- WB-M RTDB: wells/history (packet ts match) ---');
    for (const w of uniqueVariants) {
      const hist = await getRtdb(`wells/${w}/history/${job.packetTs}`);
      if (hist) {
        console.log(`  FOUND wells/${w}/history/${job.packetTs}:`, JSON.stringify(hist));
      }
    }
    // Also scan history children for packetId
    for (const w of uniqueVariants) {
      const allHist = await getRtdb(`wells/${w}/history`);
      if (allHist && typeof allHist === 'object') {
        const match = Object.entries(allHist).find(([, v]) => v?.packetId === job.packetId);
        if (match) console.log(`  history match wells/${w}/history/${match[0]}: packetId OK`);
      }
    }

    console.log('\n--- WB-M RTDB: performance ---');
    for (const w of uniqueVariants) {
      const perf = await getRtdb(`performance/${w}/rows/${job.packetTs}`);
      if (perf) console.log(`  FOUND performance/${w}/rows/${job.packetTs}:`, JSON.stringify(perf));
    }
    for (const w of [job.wellShort.replace(/\s+/g, '_'), job.wellFull.replace(/\s+/g, '_')]) {
      const perf = await getRtdb(`performance/${w}/rows/${job.packetTs}`);
      if (perf) console.log(`  FOUND performance/${w}/rows/${job.packetTs}:`, JSON.stringify(perf));
    }

    console.log('\n--- WB-M RTDB: production ---');
    for (const w of uniqueVariants) {
      const prod = await getRtdb(`production/${w}/${job.pullDate}`);
      if (prod) console.log(`  FOUND production/${w}/${job.pullDate}:`, JSON.stringify(prod));
    }

    console.log('\n--- WB-M RTDB: well_config ---');
    for (const w of uniqueVariants) {
      const cfg = await getRtdb(`well_config/${w}`);
      if (cfg) {
        console.log(`  FOUND well_config/${w}: avgFlowRate=${cfg.avgFlowRate}`);
      }
    }

    console.log('\n--- Invoice back-patch ---');
    console.log(JSON.stringify(pick(invoice, [
      'packetId', 'canonicalJobId', 'packetProcessedAt', 'packetSnapshot',
      'invoicingMode', 'status', 'totalHours',
    ]), null, 2));

    console.log('\n--- Dispatch back-patch ---');
    console.log(JSON.stringify(pick(dispatch, [
      'lastPullPacketId', 'canonicalJobId', 'pullPacketIds', 'ticketNumber', 'invoiceDocId',
    ]), null, 2));
  }

  console.log('\n' + '='.repeat(78));
  console.log('AUDIT COMPLETE');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});