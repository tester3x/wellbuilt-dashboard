import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { randomUUID } from 'crypto';
import { requireTrustedCompanyCapability, TRUSTED_CAPABILITY_MANAGE_DRIVERS } from '../security/trustedStaffAuthority';
import { callerCanViewGlobalWellPool } from '../security/dashboardCatalogProjection';
import { writeSecurityAudit } from '../security/audit';
import { digest, reviewPulls, buildHistoricalPackets, canonicalHistory, calibration, rateDisplay, type JsonRecord } from './pullImportModel';
import type { PullImportRow } from './pullParser';
import { seededStatus, seededOutgoing } from './modelSeed';
import { nextIncomingVersion } from '../incomingVersionPublish';
import { historicalAverage } from './historicalAverage';
const settings = { timeoutSeconds: 120, memory: '512MiB' as const, enforceAppCheck: false };
const fail = (message: string): never => { throw new https.HttpsError('invalid-argument', message); };
async function callerFor(uid?: string) {
  const caller = await requireTrustedCompanyCapability(uid, TRUSTED_CAPABILITY_MANAGE_DRIVERS);
  if (!callerCanViewGlobalWellPool({ companyId: caller.companyId, isPlatformAdmin: false })) throw new https.HttpsError('permission-denied', 'Global well pool access required');
  return caller;
}
async function loadContext(wells: string[]) {
  const db = admin.database();
  const configs = (await db.ref('well_config').once('value')).val() || {};
  const history: JsonRecord = {};
  const statuses: JsonRecord = {};
  const outgoing: JsonRecord = {};
  for (const well of wells) {
    if (!configs[well]) continue;
    const [packets, status, response] = await Promise.all([
      db.ref('packets/processed').orderByChild('wellName').equalTo(well).once('value'),
      db.ref(`wells/${well}/status`).once('value'),
      db.ref('packets/outgoing').orderByChild('wellName').equalTo(well).once('value'),
    ]);
    history[well] = packets.val() || {};
    statuses[well] = status.val() || null;
    outgoing[well] = response.val() || {};
  }
  return { configs, history, statuses, outgoing };
}
function contextHash(context: Awaited<ReturnType<typeof loadContext>>, wells: string[]): string {
  return digest(wells.map(well => ({ well, config: context.configs[well], history: context.history[well], status: context.statuses[well] })));
}
export const previewHistoricalPullImport = https.onCall(settings, async request => {
  const caller = await callerFor(request.auth?.uid);
  const raw = request.data || {};
  if (Object.keys(raw).some(key => !['rows', 'banks', 'acknowledged', 'calibrationConfirmed', 'sourceName'].includes(key))) fail('Unexpected preview field');
  if (!Array.isArray(raw.rows) || !raw.rows.length || raw.rows.length > 1000) fail('Preview between 1 and 1,000 rows');
  if (JSON.stringify(raw).length > 600_000) fail('Preview is too large; use a smaller date range');
  if (raw.calibrationConfirmed !== true) fail('Confirm calibration for the selected date range first');
  const allowed = new Set(['id', 'wellName', 'postedAt', 'dateTimeUTC', 'tankLevelFeet', 'bottomLevelFeet', 'bblsTaken', 'author', 'source', 'issues', 'excluded']);
  const rows: PullImportRow[] = raw.rows.map((row: JsonRecord) => {
    if (!row || typeof row !== 'object' || Object.keys(row).some(key => !allowed.has(key))) fail('Invalid row fields');
    for (const key of ['id', 'wellName', 'postedAt', 'dateTimeUTC', 'author', 'source']) if (typeof row[key] !== 'string' || row[key].length > (key === 'source' ? 4000 : 200)) fail(`Invalid ${key}`);
    if (!Array.isArray(row.issues) || row.issues.some((issue: unknown) => typeof issue !== 'string' || issue.length > 300) || typeof row.excluded !== 'boolean') fail('Invalid review fields');
    return row as PullImportRow;
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length) fail('Row identifiers must be unique');
  const banks = raw.banks || {};
  if (typeof banks !== 'object' || Array.isArray(banks) || Object.values(banks).some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1000)) fail('Invalid calibration override');
  const acknowledged = new Set<string>(Array.isArray(raw.acknowledged) ? raw.acknowledged.filter((id: unknown) => typeof id === 'string') : []);
  const context = await loadContext([...new Set(rows.map(row => row.wellName))]);
  // Resolve aliases before loading history; never trust the browser catalogue.
  const mapped = reviewPulls(rows, context.configs, {}, banks, acknowledged);
  const wells = [...new Set(mapped.filter(row => context.configs[row.wellName]).map(row => row.wellName))];
  if (wells.length > 20) fail('Import at most 20 wells per batch');
  const authoritative = await loadContext(wells);
  const reviewed = reviewPulls(rows, authoritative.configs, authoritative.history, banks, acknowledged);
  const batchId = randomUUID();
  const expiresAt = Date.now() + 20 * 60_000;
  const staged = { version: 1, uid: caller.uid, companyId: caller.companyId, state: 'preview', expiresAt, createdAt: Date.now(), sourceName: String(raw.sourceName || 'WhatsApp export').slice(0, 160), rows: reviewed, banks, wells, contextHash: contextHash(authoritative, wells), calibrationConfirmed: true };
  await admin.firestore().collection('historical_pull_imports').doc(batchId).set(staged);
  return { batchId, expiresAt, rows: reviewed, calibration: wells.map(well => ({ wellName: well, bblPerFoot: calibration(authoritative.configs[well], banks[well]), tankHeight: authoritative.configs[well].tankHeight || null })), counts: Object.fromEntries(['ready', 'review', 'duplicate', 'excluded'].map(status => [status, reviewed.filter(row => row.status === status).length])) };
});
export const applyHistoricalPullImport = https.onCall(settings, async request => {
  const caller = await callerFor(request.auth?.uid);
  const raw = request.data || {};
  if (Object.keys(raw).some(key => !['batchId', 'selectedIds'].includes(key)) || !/^[a-f0-9-]{36}$/.test(raw.batchId || '') || !Array.isArray(raw.selectedIds) || !raw.selectedIds.length || raw.selectedIds.some((id: unknown) => typeof id !== 'string')) fail('Invalid import selection');
  const ref = admin.firestore().collection('historical_pull_imports').doc(raw.batchId);
  const selectedIds = [...new Set<string>(raw.selectedIds)].sort();
  let stage: JsonRecord = {};
  const existingResult = await admin.firestore().runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new https.HttpsError('not-found', 'Preview not found');
    stage = snapshot.data()!;
    if (stage.uid !== caller.uid || stage.companyId !== caller.companyId) throw new https.HttpsError('permission-denied', 'Preview belongs to another staff member');
    if (stage.state === 'complete') {
      if (digest(selectedIds) !== stage.selectionHash) fail('This batch already imported a different selection');
      return stage.result;
    }
    if (stage.state !== 'preview') throw new https.HttpsError('failed-precondition', 'Batch already started. Make a fresh preview; existing pulls will be skipped.');
    if (stage.expiresAt < Date.now()) throw new https.HttpsError('failed-precondition', 'Preview expired; preview again');
    if (selectedIds.some(id => !stage.rows.some((row: JsonRecord) => row.id === id && row.status === 'ready'))) fail('Only ready rows can be imported');
    transaction.update(ref, { state: 'applying', startedAt: Date.now(), selectionHash: digest(selectedIds) });
    return null;
  });
  if (existingResult) return { ...existingResult, replay: true };
  let imported = 0;
  let duplicates = 0;
  try {
    const context = await loadContext(stage.wells);
    if (contextHash(context, stage.wells) !== stage.contextHash) throw new https.HttpsError('failed-precondition', 'Well history, status or calibration changed. Preview again.');
    const rows = stage.rows.filter((row: JsonRecord) => selectedIds.includes(row.id)).sort((a: JsonRecord, b: JsonRecord) => Date.parse(a.dateTimeUTC) - Date.parse(b.dateTimeUTC));
    const packets = buildHistoricalPackets(rows, context.history, raw.batchId, caller.uid, caller.companyId);
    // Deterministic per-pull transactions tolerate retries and overlapping export files.
    for (const [key, packet] of Object.entries(packets)) {
      const outcome = await admin.database().ref(`packets/processed/${key}`).transaction(current => current ? undefined : packet);
      if (outcome.committed) imported++; else duplicates++;
    }
    const modelResults: JsonRecord[] = [];
    for (const well of [...new Set<string>(rows.map((row: JsonRecord) => row.wellName))]) {
      const bank = calibration(context.configs[well], stage.banks[well]);
      const combined = { ...context.history[well], ...Object.fromEntries(Object.entries(packets).filter(([, packet]) => packet.wellName === well)) };
            const firstImportedTime = Math.min(...rows.filter((row: JsonRecord) => row.wellName === well).map((row: JsonRecord) => Date.parse(row.dateTimeUTC)));
      const history = canonicalHistory(combined).filter(row => Date.parse(row.dateTimeUTC || row.gaugeTime || row.dateTime) >= firstImportedTime);
      if (Math.abs(bank - calibration(context.configs[well])) > 0.001) {
        modelResults.push({ wellName: well, seeded: false, reason: 'Historical calibration differs from current bank; history saved, current model preserved' });
        continue;
      }
      // Reconstruct rates in chronological order using the explicitly confirmed bank.
      const rates: number[] = [];
      for (let i = 1; i < history.length; i++) {
        const a = history[i - 1], b = history[i];
        if (a.wellDown || b.wellDown) continue;
        const elapsed = (Date.parse(b.dateTimeUTC || b.gaugeTime || b.dateTime) - Date.parse(a.dateTimeUTC || a.gaugeTime || a.dateTime)) / 86400_000;
        const recovery = Number(b.tankLevelFeet) - Number(a.tankLevelFeet) + Number(a.bblsTaken) / bank;
        if (elapsed > 0 && recovery > 0 && elapsed / recovery < 365) rates.push(elapsed / recovery);
      }
      const afr = historicalAverage(rates);
      if (!afr) { modelResults.push({ wellName: well, seeded: false, reason: 'No valid recovery intervals' }); continue; }
      // Historical uploads seed the model; they never replace current/lastPull or down state.
      const configRef = admin.database().ref(`well_config/${well}`);
      const configResult = await configRef.transaction(current => {
        if (!current || digest(current) !== digest(context.configs[well])) return;
        return { ...current, avgFlowRate: rateDisplay(afr), avgFlowRateMinutes: Math.round(afr * 144000) / 100 };
      });
      const statusResult = await admin.database().ref(`wells/${well}/status`).transaction(current => {
        if (!configResult.committed || !current || digest(current) !== digest(context.statuses[well])) return;
        return seededStatus(current, context.configs[well], afr, bank, raw.batchId);
      });
      let outgoingSeeded = false;
      if (statusResult.committed) {
        for (const [key, response] of Object.entries(context.outgoing[well] || {})) {
          if (!key.startsWith('response_')) continue;
          const seed = await admin.database().ref(`packets/outgoing/${key}`).transaction(current => {
            if (!current || digest(current) !== digest(response)) return;
            return seededOutgoing(current, context.configs[well], afr, bank, raw.batchId);
          });
          outgoingSeeded = outgoingSeeded || seed.committed;
        }
        if (outgoingSeeded) await admin.database().ref('packets/incoming_version').transaction(nextIncomingVersion);
      }
      modelResults.push({ wellName: well, outgoingSeeded, seeded: configResult.committed, statusSeeded: statusResult.committed, flowRate: rateDisplay(afr), bbls24hrs: Math.round(bank / afr), reason: configResult.committed ? '' : 'Live configuration changed; historical rows saved, model seed skipped' });
    }
    const result = { batchId: raw.batchId, imported, duplicates, modelResults, completedAt: Date.now(), historicalOnly: true };
    await ref.update({ state: 'complete', result, completedAt: Date.now() });
    await writeSecurityAudit({ action: 'applyHistoricalPullImport', actorUid: caller.uid, detail: { batchId: raw.batchId, companyId: caller.companyId, imported, duplicates, wells: stage.wells } });
    return result;
  } catch (error) {
    await ref.update({ state: 'failed', imported, duplicates, failedAt: Date.now() });
    if (error instanceof https.HttpsError) throw error;
    throw new https.HttpsError('internal', `Import interrupted after ${imported} new pulls. Preview again; saved pulls will be skipped.`);
  }
});


