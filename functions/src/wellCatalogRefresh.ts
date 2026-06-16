/**
 * wellCatalogRefresh.ts — scheduled monthly NDIC well-catalog refresh + admin email.
 *
 * This is the Cloud Function twin of the proven manual importer
 * `scripts/refresh-well-catalog.js` (committed 0bca8cd). The core algorithm —
 * ndicToDoc / fetchAllFeatures / classify+diff / merge-upsert — is ported
 * faithfully from that script. KEEP THE TWO IN SYNC: a change to the mapping or
 * classification here should be mirrored in the script and vice-versa.
 *
 * SAFETY MODEL (identical to the manual script):
 *   - Upsert-only, keyed by api_no docId, via set(..., { merge: true }).
 *   - NEVER deletes a collection, doc, or field. Strips null/NaN/'' from each
 *     candidate so a sparse source row can't overwrite a good existing value.
 *   - Touches ONLY: wells, wells_inactive, wellDataMeta, plus the notification
 *     collections `mail` (Trigger-Email extension) and `well_refresh_runs`
 *     (durable audit). Does NOT touch well_config (RTDB), customLocations,
 *     swd_directory, disposals, or any dispatch/job/ticket/invoice data.
 *   - ND / NDIC only. MT/MBOGC and disposals are intentionally out of scope
 *     until their endpoint/classification mapping is confirmed.
 *
 * SCHEDULE: fires weekly Sunday 02:00 America/Chicago, but the handler no-ops
 * on any Sunday past the 7th — i.e. it runs once a month, on the FIRST Sunday.
 * (Standard cron can't express "first Sunday of the month" directly because
 * day-of-month and day-of-week OR together when both are set.)
 *
 * EMAIL: there is no SMTP/SendGrid provider wired in this codebase. We write a
 * doc to the `mail` collection using the Firebase "Trigger Email" extension
 * schema ({ to, message: { subject, text, html } }). If that extension is
 * installed the email sends; if not, the doc is a harmless record and the run
 * still persists a `well_refresh_runs` audit doc. Swap in SendGrid/Resend later
 * by changing only `sendAdminMail`.
 *
 * RECIPIENT SOURCE (resolved at send time, in priority order — see
 * resolveAdminRecipients): (1) the existing RBAC admin list — RTDB `users`
 * records with role admin/it and no companyId (WB staff), using their `email`;
 * (2) the WELL_REFRESH_ADMIN_EMAIL env var, matching this repo's existing
 * process.env config pattern (ANTHROPIC_API_KEY etc.); (3) an owner backstop so
 * a notification is never silently dropped. No new config doc or settings UI.
 */

import * as functionsV2 from 'firebase-functions/v2/scheduler';
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

// Ultimate fallback recipient, only used if no admin users resolve and no env
// var is set — so a refresh notification is never silently dropped.
const OWNER_BACKSTOP_EMAIL = 'testerg1xxx@gmail.com';
const TZ = 'America/Chicago';

const NDIC_SOURCE = {
  state: 'ND',
  label: 'NDIC DMR ArcGIS REST API',
  url: 'https://gis.dmr.nd.gov/dmrpublicservices/rest/services/OilGasPublicMapDataVectorTiles/Wells/FeatureServer/0/query',
  metaDoc: 'lastSyncND',
  page: 1000,
};
const OUT_FIELDS = [
  'well_name', 'api_no', 'operator', 'latitude', 'longitude',
  'sec', 'twp', 'rng', 'qq', 'field_name', 'County', 'well_type', 'status',
].join(',');

// ── pure helpers (ported from scripts/refresh-well-catalog.js) ────────────────
function esriEscape(s: string): string {
  return String(s).replace(/'/g, "''");
}
function numOrNull(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function intOrNull(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/** Map one NDIC ArcGIS attributes object to the exact WB ND well doc shape. */
function ndicToDoc(a: any): Record<string, any> {
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

  const raw: Record<string, any> = {
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
  const doc: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    if (typeof v === 'string' && v === '') continue;
    doc[k] = v;
  }
  return doc;
}

/** Page through an ESRI FeatureServer query, returning all attribute rows. */
async function fetchAllFeatures(where: string, limit?: number): Promise<any[]> {
  const rows: any[] = [];
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({
      where,
      outFields: OUT_FIELDS,
      returnGeometry: 'false',
      orderByFields: 'api_no',
      resultOffset: String(offset),
      resultRecordCount: String(NDIC_SOURCE.page),
      f: 'json',
    });
    const resp = await fetch(`${NDIC_SOURCE.url}?${params.toString()}`);
    if (!resp.ok) throw new Error(`ArcGIS HTTP ${resp.status}`);
    const j: any = await resp.json();
    if (j.error) throw new Error(`ArcGIS error: ${JSON.stringify(j.error)}`);
    const feats: any[] = j.features || [];
    for (const f of feats) rows.push(f.attributes);
    if (limit && rows.length >= limit) return rows.slice(0, limit);
    if (feats.length < NDIC_SOURCE.page && !j.exceededTransferLimit) break;
    if (feats.length === 0) break;
    offset += feats.length;
  }
  return rows;
}

function isUnchanged(candidate: Record<string, any>, existing: any): boolean {
  if (!existing) return false;
  for (const [k, v] of Object.entries(candidate)) {
    if (existing[k] !== v) return false;
  }
  return true;
}

// ── refresh stats shape ───────────────────────────────────────────────────────
export interface RefreshStats {
  source: string;
  write: boolean;
  upstreamRows: number;
  upActive: number;
  upInactive: number;
  wells: { add: number; update: number; unchanged: number };
  wells_inactive: { add: number; update: number; unchanged: number };
  skippedOtherStatus: number;
  byOtherStatus: Record<string, number>;
  skippedNoApi: number;
  errors: number;
  elapsedSec: number;
  baselineWells: number;
  baselineInactive: number;
  wellsCountAfter: number | null;
  metaTimestampISO: string | null;
  warnings: string[];
}

/**
 * Core NDIC refresh. Reused by both the scheduled function (write=true) and the
 * admin callable (dry-run by default). Returns full stats; performs Firestore
 * catalog writes ONLY when opts.write === true.
 */
export async function runNdicRefresh(
  db: admin.firestore.Firestore,
  opts: { write: boolean; operator?: string | null; limit?: number | null },
): Promise<RefreshStats> {
  const started = Date.now();
  const where = opts.operator ? `operator='${esriEscape(opts.operator)}'` : '1=1';

  const rows = await fetchAllFeatures(where, opts.limit || undefined);
  const upActive = rows.filter((r) => String(r.status || '').trim() === 'A').length;
  const upInactive = rows.filter((r) => String(r.status || '').trim() === 'IA').length;

  async function loadExisting(coll: string): Promise<Map<string, any>> {
    const map = new Map<string, any>();
    let q: admin.firestore.Query = db.collection(coll);
    if (opts.operator) q = q.where('operator', '==', opts.operator);
    const snap = await q.get();
    snap.forEach((d) => map.set(d.id, d.data()));
    return map;
  }
  const existingWells = await loadExisting('wells');
  const existingInactive = await loadExisting('wells_inactive');

  const stats: RefreshStats = {
    source: NDIC_SOURCE.label,
    write: opts.write,
    upstreamRows: rows.length,
    upActive,
    upInactive,
    wells: { add: 0, update: 0, unchanged: 0 },
    wells_inactive: { add: 0, update: 0, unchanged: 0 },
    skippedOtherStatus: 0,
    byOtherStatus: {},
    skippedNoApi: 0,
    errors: 0,
    elapsedSec: 0,
    baselineWells: existingWells.size,
    baselineInactive: existingInactive.size,
    wellsCountAfter: null,
    metaTimestampISO: null,
    warnings: [],
  };

  const ops: { coll: 'wells' | 'wells_inactive'; id: string; data: Record<string, any> }[] = [];
  for (const a of rows) {
    try {
      const status = String(a.status || '').trim();
      const apiNo = String(a.api_no || '').trim();
      if (!apiNo) { stats.skippedNoApi++; continue; }

      let coll: 'wells' | 'wells_inactive';
      let existingMap: Map<string, any>;
      if (status === 'A') { coll = 'wells'; existingMap = existingWells; }
      else if (status === 'IA') { coll = 'wells_inactive'; existingMap = existingInactive; }
      else {
        stats.skippedOtherStatus++;
        const k = status || '(blank)';
        stats.byOtherStatus[k] = (stats.byOtherStatus[k] || 0) + 1;
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

  if (opts.write && ops.length) {
    for (let i = 0; i < ops.length; i += 500) {
      const batch = db.batch();
      for (const op of ops.slice(i, i + 500)) {
        batch.set(db.collection(op.coll).doc(op.id), op.data, { merge: true });
      }
      await batch.commit();
    }
    const wellsCount = (await db.collection('wells').count().get()).data().count;
    stats.wellsCountAfter = wellsCount;
    const metaTs = new Date();
    stats.metaTimestampISO = metaTs.toISOString();
    await db.collection('wellDataMeta').doc(NDIC_SOURCE.metaDoc).set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      wellCount: wellsCount,
      source: NDIC_SOURCE.label,
      lastRefreshStats: {
        upstreamRows: rows.length,
        wellsAdded: stats.wells.add,
        wellsUpdated: stats.wells.update,
        inactiveAdded: stats.wells_inactive.add,
        inactiveUpdated: stats.wells_inactive.update,
        operatorScope: opts.operator || 'ALL',
      },
    }, { merge: true });
  }

  stats.elapsedSec = Number(((Date.now() - started) / 1000).toFixed(1));

  // Warnings (full-catalog runs only — operator-scoped baselines are partial).
  if (!opts.operator && opts.write && stats.wellsCountAfter != null) {
    if (stats.wellsCountAfter < stats.baselineWells) {
      stats.warnings.push(
        `wells count DROPPED ${stats.baselineWells} → ${stats.wellsCountAfter} (upsert-only should never reduce — investigate)`,
      );
    }
  }
  if (stats.errors > 0) stats.warnings.push(`${stats.errors} row mapping error(s) during refresh`);

  return stats;
}

// ── email + audit ─────────────────────────────────────────────────────────────
function fmtCounts(c: { add: number; update: number; unchanged: number }): string {
  return `add=${c.add} update=${c.update} unchanged=${c.unchanged}`;
}

export function buildSuccessEmail(stats: RefreshStats): { subject: string; text: string } {
  const warn = stats.warnings.length > 0;
  const subject = warn
    ? `⚠️ WB Well Refresh completed WITH WARNINGS (+${stats.wells.add} wells)`
    : `✅ WB Well Refresh OK — +${stats.wells.add} wells, +${stats.wells_inactive.add} inactive (NDIC)`;
  const lines = [
    `WellBuilt monthly well-catalog refresh — ${stats.write ? 'WRITE' : 'DRY-RUN'}`,
    ``,
    `Run timestamp:     ${new Date().toISOString()}`,
    `Source:            ${stats.source}`,
    `wellDataMeta ts:   ${stats.metaTimestampISO || '(dry-run — not written)'}`,
    `Elapsed:           ${stats.elapsedSec}s`,
    ``,
    `Upstream rows:     ${stats.upstreamRows} (active A=${stats.upActive}, inactive IA=${stats.upInactive})`,
    `wells:             ${fmtCounts(stats.wells)}`,
    `wells_inactive:    ${fmtCounts(stats.wells_inactive)}`,
    `wells count after: ${stats.wellsCountAfter ?? '(dry-run)'} (baseline ${stats.baselineWells})`,
    ``,
    `Skipped (other status): ${stats.skippedOtherStatus} ${JSON.stringify(stats.byOtherStatus)}`,
    `Skipped (no api_no):    ${stats.skippedNoApi}`,
    `Errors:                 ${stats.errors}`,
  ];
  if (warn) {
    lines.push(``, `WARNINGS:`);
    for (const w of stats.warnings) lines.push(`  - ${w}`);
  }
  lines.push(
    ``,
    `Note: upsert-only / merge — no collection or doc was wiped.`,
    `MT/MBOGC and disposals are out of scope for this refresh.`,
  );
  return { subject, text: lines.join('\n') };
}

export function buildFailureEmail(err: any, sourceLabel: string): { subject: string; text: string } {
  const subject = `❌ WB Well Refresh FAILED (NDIC)`;
  const text = [
    `WellBuilt monthly well-catalog refresh FAILED.`,
    ``,
    `Run timestamp:    ${new Date().toISOString()}`,
    `Source attempted: ${sourceLabel}`,
    `Error:            ${err && err.message ? err.message : String(err)}`,
    ``,
    `Stack:`,
    (err && err.stack) ? String(err.stack) : '(no stack available)',
    ``,
    `The existing Firestore well catalog was NOT wiped — this importer is`,
    `upsert-only and never deletes. No partial deletion occurs on failure.`,
  ].join('\n');
  return { subject, text };
}

/**
 * Resolve admin notification recipients in priority order:
 *   1. RBAC admin list — RTDB `users` with role admin/it and no companyId
 *      (WB staff), using each record's backfilled `email`.
 *   2. WELL_REFRESH_ADMIN_EMAIL env var (matches the repo's process.env config
 *      pattern) if no admin users resolved.
 *   3. Owner backstop, so a notification is never silently dropped.
 */
async function resolveAdminRecipients(): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (e?: string) => {
    const email = typeof e === 'string' ? e.trim() : '';
    if (!email) return;
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(email);
  };
  try {
    const snap = await admin.database().ref('users').once('value');
    const users = snap.val() || {};
    for (const uid of Object.keys(users)) {
      const u = users[uid] || {};
      const isWbStaff = !u.companyId;                       // WB admin, not a hauler
      const elevated = u.role === 'admin' || u.role === 'it';
      if (isWbStaff && elevated) add(u.email);
    }
  } catch (_e) {
    // fall through to env / backstop
  }
  if (out.length === 0) add(process.env.WELL_REFRESH_ADMIN_EMAIL);
  if (out.length === 0) add(OWNER_BACKSTOP_EMAIL);
  return out;
}

/** Deliver via the Firebase "Trigger Email" extension schema. No-op-safe. */
async function sendAdminMail(
  db: admin.firestore.Firestore,
  mail: { subject: string; text: string },
): Promise<void> {
  const to = await resolveAdminRecipients();
  await db.collection('mail').add({
    to,
    message: { subject: mail.subject, text: mail.text, html: `<pre>${mail.text}</pre>` },
    _source: 'wellCatalogRefresh',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function writeRunAudit(
  db: admin.firestore.Firestore,
  record: Record<string, any>,
): Promise<void> {
  await db.collection('well_refresh_runs').add({
    ...record,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/** True only on the first Sunday of the month (date 1-7), evaluated in TZ. */
function isFirstSundayOfMonth(): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, day: 'numeric' }).formatToParts(new Date());
  const dom = parseInt(parts.find((p) => p.type === 'day')?.value || '99', 10);
  return dom >= 1 && dom <= 7;
}

// ── scheduled function (monthly, first Sunday ~02:00 Central) ──────────────────
export const scheduledWellCatalogRefresh = functionsV2.onSchedule(
  {
    schedule: 'every sunday 02:00',
    timeZone: TZ,
    memory: '1GiB',
    timeoutSeconds: 540,
    retryCount: 0,
  },
  async () => {
    const db = admin.firestore();
    if (!isFirstSundayOfMonth()) {
      console.log('[WellRefresh] Not the first Sunday of the month — skipping.');
      return;
    }
    console.log('[WellRefresh] Monthly NDIC catalog refresh starting (write)...');
    try {
      const stats = await runNdicRefresh(db, { write: true });
      console.log('[WellRefresh] Done:', JSON.stringify(stats));
      await writeRunAudit(db, { outcome: 'success', ...stats });
      await sendAdminMail(db, buildSuccessEmail(stats));
    } catch (err: any) {
      console.error('[WellRefresh] FAILED:', err);
      await writeRunAudit(db, {
        outcome: 'failure',
        source: NDIC_SOURCE.label,
        error: err && err.message ? err.message : String(err),
        stack: err && err.stack ? String(err.stack) : null,
      });
      await sendAdminMail(db, buildFailureEmail(err, NDIC_SOURCE.label));
      throw err; // surface failure to Cloud Monitoring
    }
  },
);

// ── admin callable (manual / dry-run / email-path test, no destructive writes) ─
// Defaults to DRY-RUN. Pass { dryRun: false } to perform the production write.
// sendEmail defaults true so the email/audit path is exercised in dry-run too.
export const triggerWellCatalogRefresh = httpsV2.onCall(
  { memory: '1GiB', timeoutSeconds: 540 },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new httpsV2.HttpsError('unauthenticated', 'Sign in required.');
    // WB-staff-only gate: role admin/it AND no companyId. Matches
    // resolveAdminRecipients — a hauler/customer admin (has companyId) must NOT
    // be able to run a refresh against the shared global catalog.
    const userSnap = await admin.database().ref(`users/${uid}`).once('value');
    const u = userSnap.val() || {};
    const allowed = !u.companyId && (u.role === 'admin' || u.role === 'it');
    if (!allowed) throw new httpsV2.HttpsError('permission-denied', 'WB admin only.');

    const dryRun = request.data?.dryRun !== false; // default true
    const sendEmail = request.data?.sendEmail !== false; // default true
    const operator = request.data?.operator || null;
    const limit = request.data?.limit || null;

    const db = admin.firestore();
    try {
      const stats = await runNdicRefresh(db, { write: !dryRun, operator, limit });
      await writeRunAudit(db, { outcome: 'success', trigger: 'callable', dryRun, ...stats });
      if (sendEmail) await sendAdminMail(db, buildSuccessEmail(stats));
      return { ok: true, dryRun, stats };
    } catch (err: any) {
      await writeRunAudit(db, {
        outcome: 'failure', trigger: 'callable', dryRun,
        source: NDIC_SOURCE.label,
        error: err && err.message ? err.message : String(err),
        stack: err && err.stack ? String(err.stack) : null,
      });
      if (sendEmail) await sendAdminMail(db, buildFailureEmail(err, NDIC_SOURCE.label));
      throw new httpsV2.HttpsError('internal', err?.message || 'refresh failed');
    }
  },
);
