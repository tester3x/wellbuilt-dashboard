import * as admin from 'firebase-admin';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { calibration, feetDisplay } from '../../imports/pullImportModel';
import { deriveLocalDateTime } from '../../recoverRejectedPull';
import { loadCanonicalDriverAuthority, productionCanonicalDriverReaders } from '../canonicalDriverAuthority';
import { assertWbmWriter } from './viewerWriteGuard';
import { evaluateWbmWellScope, wellBelongsToDriverCompany, wellMatchesWbmScope } from './wbmWellScope';
import { historyPullDigest, historyPullEvidence, historyPullKey, historyPullRoute, matchHistoryWell, type HistoryRecord } from './historyPullPlan';

const millis = (value: unknown) => Date.parse(typeof value === 'string' ? value : '') || 0;
const revisionOf = (row: HistoryRecord | undefined) => row?.revision?.toMillis?.();

type SyncResult = string | { status: string; packetId: string; dateTimeUTC: string };

export async function reconcileHistoryPull(
  intent: HistoryRecord, ticket: HistoryRecord, invoice: HistoryRecord,
  isCurrent: () => Promise<boolean> = async () => true,
): Promise<SyncResult> {
  const { driverId, companyId, invoiceDocId } = intent;
  const evidence = historyPullEvidence(ticket, invoice);
  if (!evidence) return 'not_applicable';
  const rtdb = admin.database();
  const read = async (path: string) => (await rtdb.ref(path).get()).val();
  const [authority, profile, configs, company] = await Promise.all([
    loadCanonicalDriverAuthority(driverId, productionCanonicalDriverReaders()),
    read('drivers/profiles/' + driverId), read('well_config'),
    admin.firestore().doc('companies/' + companyId).get(),
  ]);
  if (!authority?.active || authority.companyId !== companyId || !profile || !configs) return 'review';
  if (company.data()?.wellMonitoring === false) return 'not_applicable';
  try {
    assertWbmWriter(profile, []);
  } catch {
    return 'review';
  }
  const scope = evaluateWbmWellScope(profile.assignedRoutes, profile.assignedWells);
  const match = matchHistoryWell(ticket, invoice, configs);
  if (!scope.ok || !match) return 'review';
  const [wellName, config] = match;
  if (!wellBelongsToDriverCompany(config, companyId) || !wellMatchesWbmScope(wellName, config, scope)) return 'review';
  if (config.routeType === 'freshwater') return 'not_applicable';
  const stableKey = historyPullKey(ticket, invoice, invoiceDocId);
  if (!stableKey) return 'review';

  const readBy = async (area: string, field: string, value: string) =>
    ((await rtdb.ref('packets/' + area).orderByChild(field).equalTo(value).once('value')).val() || {}) as Record<string, HistoryRecord>;
  const [byWell, byInvoice, incoming, raw, legacy, rawPending, legacyPending, rejected, legacyRejected, outgoing, liveWell] = await Promise.all([
    readBy('processed', 'wellName', wellName), readBy('processed', 'invoiceDocId', invoiceDocId),
    readBy('incoming', 'invoiceDocId', invoiceDocId),
    read('packets/processed/' + stableKey), read('packets/processed/idem_' + stableKey),
    read('packets/incoming/' + stableKey), read('packets/incoming/idem_' + stableKey),
    read('packets/rejected/' + stableKey), read('packets/rejected/idem_' + stableKey),
    read('packets/outgoing/' + wellName.replace(/\s/g, '')), read('wells/' + wellName + '/status/lastPull'),
  ]);
  const originals: Record<string, HistoryRecord> = { ...byInvoice };
  if (raw) originals[stableKey] = raw;
  if (legacy) originals['idem_' + stableKey] = legacy;
  const originalEntries = Object.entries(originals).filter(([, row]) => row.requestType === 'pull' || !row.requestType);
  if (originalEntries.length > 1 || (rejected && legacyRejected)) return 'review';
  const [originalKey, original] = originalEntries[0] || [];
  const pending = rawPending || legacyPending || Object.values(incoming).find(row => row.requestType === 'pull');
  const at = millis(evidence.at);
  const equivalent = !original && !!at && Object.values(byWell).some(row =>
    Math.abs(millis(row.dateTimeUTC) - at) <= 120000 &&
    Math.abs(Number(row.tankLevelFeet) - evidence.top) < 1 / 12 &&
    Math.abs(Number(row.bblsTaken) - evidence.barrels) < 0.1);
  const latest = Object.values(byWell).reduce((latest, row) => Math.max(latest, millis(row.dateTimeUTC)),
    Math.max(millis(outgoing?.lastPullDateTimeUTC), millis(liveWell?.dateTimeUTC)));
  const route = historyPullRoute({ original, pending, rejection: rejected || legacyRejected, evidence,
    owner: { driverId, companyId, invoiceId: invoiceDocId }, wellName, latest, equivalent,
    legacyRecoveryOnly: intent.legacyRecoveryOnly === true });
  if (route === 'wait') throw new Error('History pull is still processing');
  if (route === 'review') return route;
  if (route === 'unchanged') {
    if (original.source === 'wbt_history_correction' && !original.historicalOnly &&
      original.canonicalProcessingComplete !== true) throw new Error('History pull is still processing');
    const status = original.historicalOnly ? 'historical'
      : original.source === 'wbt_history_correction' ? 'complete' : 'unchanged';
    return { status, packetId: originalKey, dateTimeUTC: original.dateTimeUTC };
  }
  const bank = calibration(config);
  // The standard processor derives bottom from the calibrated tank and volume.
  // An inconsistent record needs review, rather than publishing a different gauge.
  if (!(bank > 0) || (route !== 'historical' && evidence.bottom !== undefined &&
    Math.abs(evidence.top - evidence.barrels / bank - evidence.bottom) > 1 / 12)) return 'review';
  if (!await isCurrent()) return 'superseded';
  const revision = revisionOf(intent);
  const editKey = 'edit_history_' + historyPullDigest(invoiceDocId, originalKey, revision).slice(0, 40);
  const packet = {
    packetId: originalKey || stableKey,
    wellName, tankLevelFeet: evidence.top, bblsTaken: evidence.barrels, companyId, driverId,
    driverName: ticket.driver || invoice.driver || null, invoiceDocId,
    ticketNumber: String(ticket.ticketNumber), jobType: evidence.jobType,
    originAppContext: 'wbt', source: 'wbt_history_correction', wellDownIsAuthoritative: false,
  };
  const digest = historyPullDigest(packet, original?.dateTimeUTC || evidence.at, evidence.bottom);
  const createOnce = async (path: string, row: HistoryRecord) => {
    const result = await rtdb.ref(path).transaction(current => current ? undefined : row);
    const saved = result.snapshot.val();
    const owned = saved?.invoiceDocId === invoiceDocId && saved?.companyId === companyId && saved?.driverId === driverId;
    if (owned && saved.payloadDigest !== digest) throw new Error('An owned packet changed during reconciliation');
    return owned;
  };
  if (route === 'edit') {
    const queued = await createOnce('packets/incoming/' + editKey, {
      ...packet, requestType: 'edit', originalPacketId: originalKey, editEventId: editKey,
      revisionAt: revision, idempotencyKey: editKey, payloadDigest: digest,
    });
    return queued ? { status: 'queued', packetId: originalKey, dateTimeUTC: original.dateTimeUTC } : 'review';
  }
  if (!at || at > Date.now() || at > (invoice.closedAt?.toMillis?.() || millis(invoice.closedAt))) return 'review';
  const dateTimeUTC = evidence.at;
  const timezone = typeof invoice.timezone === 'string' ? invoice.timezone : 'America/Chicago';
  const pull = { ...packet, requestType: 'pull', dateTime: deriveLocalDateTime(dateTimeUTC!, timezone), dateTimeUTC, timezone,
    idempotencyKey: stableKey, payloadDigest: digest, historyTimeSource: evidence.timeSource };
  if (route === 'historical') {
    if (evidence.bottom === undefined) return 'review';
    // Mobile Pull History reads processed packets. No outgoing/current/lastPull write.
    const saved = await createOnce('packets/processed/' + stableKey, {
      ...pull, historicalOnly: true, processedAt: new Date().toISOString(),
      tankTopInches: evidence.top * 12, tankAfterInches: evidence.bottom * 12,
      tankAfterFeet: feetDisplay(evidence.bottom), flowRateDays: 0, flowRate: '',
    });
    return saved ? { status: 'historical', packetId: stableKey, dateTimeUTC: dateTimeUTC! } : 'review';
  }
  const queued = await createOnce('packets/incoming/' + stableKey, pull);
  if (queued) throw new Error('History pull queued; awaiting processor receipt');
  return 'review';
}

export const syncHistoryPull = onDocumentWritten({
  document: 'history_pull_sync/{ticketId}', region: 'us-central1', retry: true,
}, async event => {
  const after = event.data?.after, intent = after?.data();
  if (!after || !intent || intent.status !== 'pending') return;
  const revision = revisionOf(intent);
  if (!revision || intent.ticketDocId !== event.params.ticketId ||
    ![intent.invoiceDocId, intent.companyId, intent.driverId].every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(id))) return;
  const fs = admin.firestore();
  const [current, ticketSnap, invoiceSnap] = await fs.getAll(after.ref, fs.doc('tickets/' + intent.ticketDocId),
    fs.doc('invoices/' + intent.invoiceDocId));
  if (revisionOf(current.data()) !== revision || current.data()?.status !== 'pending') return;
  const ticket = ticketSnap.data(), invoice = invoiceSnap.data();
  const closedAt = invoice?.closedAt?.toMillis?.() || millis(invoice?.closedAt) || Number(invoice?.closedAtMs);
  let result: SyncResult = 'review';
  if (ticket && invoice && ticket.invoiceDocId === intent.invoiceDocId &&
    ticket.companyId === intent.companyId && invoice.companyId === intent.companyId &&
    (ticket.ownerDriverId || invoice.driverHash) === intent.driverId &&
    (!invoice.driverHash || invoice.driverHash === intent.driverId) &&
    invoice.invoicingMode === 'ticket_only' && (invoice.packageId || ticket.packageId || 'water-hauling') === 'water-hauling' &&
    ['closed', 'complete', 'completed'].includes(String(invoice.status).toLowerCase()) &&
    closedAt > 0 && revision >= closedAt && revision - closedAt < 24 * 60 * 60 * 1000 &&
    invoice.tickets?.length === 1 && String(invoice.tickets[0]) === String(ticket.ticketNumber) &&
    ![invoice, ticket].some(row => row.haulGroupId || row.splitChainId || row.splitChainSeq || row.splitGroupId ||
      row.dispatchSplitGroupId || row.dispatchSplitSequence || row.transferSourceDocId || row.transferredTo ||
      row.transferredToHash || row.lockedForTransfer || row.billingInvoiceId || row.payrollTimesheetId)) {
    result = await reconcileHistoryPull(intent, ticket, invoice, async () => {
      const latest = (await after.ref.get()).data();
      return latest?.status === 'pending' && revisionOf(latest) === revision;
    });
  }
  await fs.runTransaction(async tx => {
    const live = (await tx.get(after.ref)).data();
    if (live?.status === 'pending' && revisionOf(live) === revision) {
      const status = typeof result === 'string' ? result : result.status;
      if (typeof result !== 'string' && result.packetId && result.dateTimeUTC) {
        const [latestTicket, latestInvoice] = await tx.getAll(ticketSnap.ref, invoiceSnap.ref);
        const t = latestTicket.data(), i = latestInvoice.data();
        const oldKey = historyPullKey(ticket!, invoice!, intent.invoiceDocId);
        if (t && i && t.invoiceDocId === intent.invoiceDocId && t.companyId === intent.companyId &&
          i.companyId === intent.companyId && historyPullKey(t, i, intent.invoiceDocId) === oldKey) {
          if (t.packetId !== result.packetId) tx.update(ticketSnap.ref, { packetId: result.packetId });
          if (i.packetId !== result.packetId || i.packetDateTimeUTC !== result.dateTimeUTC) {
            tx.update(invoiceSnap.ref, { packetId: result.packetId, packetDateTimeUTC: result.dateTimeUTC });
          }
        }
      }
      tx.update(after.ref, { status, handledAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  });
});
