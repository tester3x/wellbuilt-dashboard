const PROJECT = 'wellbuilt-sync';
const RTDB = 'https://wellbuilt-sync-default-rtdb.firebaseio.com';

async function runQuery(collection, filters) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`;
  let where = null;
  for (const f of filters) {
    const clause = {
      fieldFilter: {
        field: { fieldPath: f.field },
        op: f.op,
        value: f.type === 'number' ? { doubleValue: f.value } : { stringValue: String(f.value) },
      },
    };
    where = where ? { compositeFilter: { op: 'AND', filters: [where, clause] } } : clause;
  }
  const body = { structuredQuery: { from: [{ collectionId: collection }], where } };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function getDoc(collection, id) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${collection}/${id}`;
  const res = await fetch(url);
  if (res.status === 404 || res.status === 403) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
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

function parseDoc(rowOrDoc) {
  if (!rowOrDoc) return null;
  const doc = rowOrDoc.document || rowOrDoc;
  if (!doc || !doc.fields) return null;
  const id = doc.name.split('/').pop();
  const out = { _id: id };
  for (const [k, v] of Object.entries(doc.fields)) out[k] = parseValue(v);
  return out;
}

const JOBS = [
  {
    label: 'Job1',
    ticket: '19064',
    invoiceDocId: 'kt55zF0JIiKRy0gz7Ywp',
    dispatchId: 'eSf9PwSiWTgapf6GyNAj',
    packetId: '20260705_092317_Gabriel5_sleu27',
    ticketDocId: 'DdFNgeW8yC1J6GjPmq2y',
  },
  {
    label: 'Job2',
    ticket: '19065',
    invoiceDocId: 'p6Bojd25U5wXQOIsu8nh',
    dispatchId: 'Ljogsun7Jin5riEoas4n',
    packetId: '20260705_105631_Thor1_ate2l2',
    ticketDocId: 'a33GWmidkpJpytAWCRsw',
  },
];

function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label} | ${detail}`);
}

(async () => {
  for (const job of JOBS) {
    console.log('\n' + '='.repeat(72));
    console.log(`AUDIT ${job.label} — ticket #${job.ticket}`);
    console.log('='.repeat(72));

    const invoice = parseDoc(await getDoc('invoices', job.invoiceDocId));
    const ticketDoc = parseDoc(await getDoc('tickets', job.ticketDocId));
    const dispatch = parseDoc(await getDoc('dispatches', job.dispatchId));
    const canonical = parseDoc(await getDoc('canonical_jobs', job.packetId));

    const procRes = await fetch(`${RTDB}/packets/processed/${job.packetId}.json`);
    const procPkt = procRes.ok ? await procRes.json() : null;
    const inRes = await fetch(`${RTDB}/packets/incoming/${job.packetId}.json`);
    const inPkt = inRes.ok ? await inRes.json() : null;

    console.log('\n-- Identity chain --');
    console.log(
      JSON.stringify(
        {
          ticketNumber: job.ticket,
          invoiceDocId: job.invoiceDocId,
          dispatchId: job.dispatchId,
          packetId: job.packetId,
          canonicalJobId: invoice?.canonicalJobId,
          ticketDocId_invoice: invoice?.ticketSummaries?.[0]?.docId,
          ticketDocId_tickets: ticketDoc?._id,
        },
        null,
        2,
      ),
    );

    check('invoice.status closed', invoice?.status === 'closed', invoice?.status);
    check('dispatch.status completed', dispatch?.status === 'completed', dispatch?.status);
    check('invoice.dispatchId matches', invoice?.dispatchId === job.dispatchId, `${invoice?.dispatchId}`);
    check('dispatch.invoiceDocId matches', dispatch?.invoiceDocId === job.invoiceDocId, `${dispatch?.invoiceDocId}`);
    check('ticket.invoiceDocId matches', ticketDoc?.invoiceDocId === job.invoiceDocId, `${ticketDoc?.invoiceDocId}`);
    check('ticket.dispatchId matches', ticketDoc?.dispatchId === job.dispatchId, `${ticketDoc?.dispatchId}`);
    check('canonical exists', !!canonical, canonical?._id || 'missing');
    check('canonical.packetId', canonical?.packetId === job.packetId, `${canonical?.packetId}`);
    check('canonical.invoiceDocId', canonical?.invoiceDocId === job.invoiceDocId, `${canonical?.invoiceDocId}`);
    check('canonical.ticketDocId', canonical?.ticketDocId === job.ticketDocId, `${canonical?.ticketDocId}`);
    check('canonical.dispatchId', canonical?.dispatchId === job.dispatchId, `${canonical?.dispatchId}`);
    check('invoice.canonicalJobId', invoice?.canonicalJobId === job.packetId, `${invoice?.canonicalJobId}`);
    check('invoice.packetId', invoice?.packetId === job.packetId, `${invoice?.packetId}`);
    check('ticket number in invoice.tickets', (invoice?.tickets || []).includes(job.ticket), JSON.stringify(invoice?.tickets));
    check('ticket summary docId', invoice?.ticketSummaries?.[0]?.docId === job.ticketDocId, `${invoice?.ticketSummaries?.[0]?.docId}`);
    check('dispatch.ticketNumber', String(dispatch?.ticketNumber) === job.ticket, `${dispatch?.ticketNumber}`);
    check('RTDB processed packet exists', !!procPkt, procPkt ? 'yes' : 'no');
    check('RTDB packetId field matches', procPkt?.packetId === job.packetId, `${procPkt?.packetId}`);

    const invBbl = invoice?.totalBBL;
    const tktBbl = Number(ticketDoc?.qty ?? ticketDoc?.bbls ?? 0);
    const sumBbl = Number(invoice?.ticketSummaries?.[0]?.qty ?? 0);
    const pktBbl = Number(procPkt?.bblsTaken ?? invoice?.packetSnapshot?.bblsTaken ?? 0);
    const dispBbl = Number(dispatch?.totalBBL ?? 0);
    check('BBL invoice.totalBBL', invBbl === 140, `${invBbl}`);
    check('BBL ticket qty', tktBbl === 140, `${tktBbl}`);
    check('BBL ticketSummary qty', sumBbl === 140, `${sumBbl}`);
    check('BBL packet processed', pktBbl === 140, `${pktBbl}`);
    check('BBL dispatch.totalBBL', dispBbl === 140, `${dispBbl}`);
    check('BBL canonical', Number(canonical?.bblsTaken ?? 0) === 140, `${canonical?.bblsTaken}`);

    console.log('\n-- Well / disposal --');
    console.log(
      JSON.stringify(
        {
          invoice_well: invoice?.wellName,
          ticket_well: ticketDoc?.wellName || ticketDoc?.location,
          dispatch_well: dispatch?.wellName,
          canonical_well: canonical?.wellName,
          packet_well: procPkt?.wellName || invoice?.packetSnapshot?.wellName,
          invoice_hauledTo: invoice?.hauledTo,
          ticket_hauledTo: ticketDoc?.hauledTo,
          ticket_disposal: ticketDoc?.disposal,
          dispatch_hauledTo: dispatch?.hauledTo || dispatch?.disposal,
        },
        null,
        2,
      ),
    );

    console.log('\n-- Timeline events --');
    (invoice?.timeline || []).forEach((e, i) =>
      console.log(`  ${i + 1}. ${e.type} @ ${e.timestamp} leg=${e.leg} loc=${e.locationName} lat=${e.lat} lng=${e.lng}`),
    );

    console.log('\n-- Ticket doc key fields --');
    console.log(
      JSON.stringify(
        {
          ticketNumber: ticketDoc?.ticketNumber,
          top: ticketDoc?.top,
          bottom: ticketDoc?.bottom,
          qty: ticketDoc?.qty,
          bbls: ticketDoc?.bbls,
          operator: ticketDoc?.operator,
          county: ticketDoc?.county,
          driver: ticketDoc?.driver,
          driverId: ticketDoc?.driverId,
          packetId: ticketDoc?.packetId,
          wbMobilePacketId: ticketDoc?.wbMobilePacketId,
          createdAt: ticketDoc?.createdAt,
        },
        null,
        2,
      ),
    );

    console.log('\n-- Dispatch key fields --');
    console.log(
      JSON.stringify(
        {
          status: dispatch?.status,
          driverStage: dispatch?.driverStage,
          driverName: dispatch?.driverName,
          driverHash: dispatch?.driverHash,
          completedAt: dispatch?.completedAt,
          invoiceNumber: dispatch?.invoiceNumber,
          invoicingMode: dispatch?.invoicingMode,
        },
        null,
        2,
      ),
    );

    console.log('\n-- Canonical events --');
    if (!canonical?.events?.length) console.log('  (no events array or empty)');
    else canonical.events.forEach((e, i) => console.log(`  ${i + 1}. ${e.type || e.event} @ ${e.at || e.timestamp} ${e.notes || ''}`));

    console.log('\n-- Anomaly scan --');
    const anomalies = [];
    if (!invoice?.invoiceNumber) anomalies.push('invoiceNumber empty (ticket_only expected)');
    if (invoice?.departedEvent?.lat === '0' || invoice?.departedEvent?.lat === 0)
      anomalies.push('departedEvent lat/lng zero at job start');
    if (!invoice?.arrivedEvent) anomalies.push('arrivedEvent null on invoice root (timeline has arrive)');
    if (!invoice?.closedEvent) anomalies.push('closedEvent null on invoice root (timeline has close)');
    const types = (invoice?.timeline || []).map((e) => e.type);
    if (!types.includes('depart')) anomalies.push('no depart event in timeline');
    if (job.label === 'Job2') {
      const ds = invoice?.timeline?.find((e) => e.type === 'depart_site');
      const arr = [...(invoice?.timeline || [])].reverse().find((e) => e.type === 'arrive');
      if (ds && arr && ds.lat === arr.lat && ds.lng === arr.lng)
        anomalies.push('dropoff arrive GPS equals depart_site GPS (well coords, not SWD)');
      if (invoice?.totalHours < 0.1) anomalies.push('totalHours 0.03 — rushed test, not corruption');
    }
    if (inPkt) anomalies.push('packet still in incoming queue');
    anomalies.forEach((a) => console.log('  * ' + a));
    if (!anomalies.length) console.log('  (none flagged)');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});