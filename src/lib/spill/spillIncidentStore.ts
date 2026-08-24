/**
 * Read-only Firestore access for companies/{companyId}/spill_incidents.
 * Never writes incidents (actions go through governed callables).
 */
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { getFirestoreDb } from '../firebase';
import {
  classifyFirestoreSpillError,
  projectSpillDetail,
  projectSpillListRow,
  type SpillDetailView,
  type SpillListRow,
  type SpillLoadState,
} from './spillIncidentProjection';
import { safetyCollectionPath, safetyDeliveriesPath, safetyIncidentPath } from './spillAccess';

export const MEDIA_INFRA_READY = false;
export const NOTIFY_WORKER_DEPLOYED = false;
export const NOTIFY_PROVIDER_CONFIGURED = false;

export async function listSpillIncidents(
  companyId: string,
  opts?: { companyName?: string | null },
): Promise<{ state: SpillLoadState; rows: SpillListRow[] }> {
  try {
    const db = getFirestoreDb();
    const snap = await getDocs(collection(db, safetyCollectionPath(companyId)));
    const rows: SpillListRow[] = [];
    snap.forEach((d) => {
      const row = projectSpillListRow(
        { incidentId: d.id, ...(d.data() || {}) },
        {
          companyName: opts?.companyName ?? null,
          workerDeployed: NOTIFY_WORKER_DEPLOYED,
          providerConfigured: NOTIFY_PROVIDER_CONFIGURED,
          mediaInfraReady: MEDIA_INFRA_READY,
        },
      );
      if (row) rows.push(row);
    });
    rows.sort((a, b) => String(b.occurredAtIso || '').localeCompare(String(a.occurredAtIso || '')));
    return { state: rows.length === 0 ? { kind: 'empty' } : { kind: 'ready' }, rows };
  } catch (err) {
    return { state: classifyFirestoreSpillError(err), rows: [] };
  }
}

export async function getSpillIncident(
  companyId: string,
  incidentId: string,
  opts?: { companyName?: string | null },
): Promise<{ state: SpillLoadState; detail: SpillDetailView | null }> {
  try {
    const db = getFirestoreDb();
    const snap = await getDoc(doc(db, safetyIncidentPath(companyId, incidentId)));
    if (!snap.exists()) return { state: { kind: 'empty' }, detail: null };
    let deliveries: unknown[] = [];
    try {
      const dSnap = await getDocs(collection(db, safetyDeliveriesPath(companyId, incidentId)));
      dSnap.forEach((d) => deliveries.push({ deliveryId: d.id, ...(d.data() || {}) }));
    } catch {
      deliveries = [];
    }
    const detail = projectSpillDetail(
      { incidentId: snap.id, ...(snap.data() || {}) },
      {
        deliveries,
        companyName: opts?.companyName ?? null,
        workerDeployed: NOTIFY_WORKER_DEPLOYED,
        providerConfigured: NOTIFY_PROVIDER_CONFIGURED,
        mediaInfraReady: MEDIA_INFRA_READY,
      },
    );
    if (!detail) return { state: { kind: 'error', message: 'Malformed incident' }, detail: null };
    return { state: { kind: 'ready' }, detail };
  } catch (err) {
    return { state: classifyFirestoreSpillError(err), detail: null };
  }
}
