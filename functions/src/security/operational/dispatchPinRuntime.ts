import * as admin from 'firebase-admin';
import {
  REVISION_COLLECTION,
  revisionDocId,
  type ImmutableRevisionEnvelope,
  type StoreResult,
} from './jobPacketRevisionStore';
import {
  evaluateWellAuthorized,
  loadVerifiedRevisionFromData,
  parsePacketRef,
  type PacketRef,
} from './dispatchPacketPin';

export function packetRefFromDispatch(job: Record<string, unknown>): StoreResult<{ packetRef: PacketRef }> {
  const packageId = typeof job.packageId === 'string' ? job.packageId : '';
  const revision = typeof job.packetRevision === 'number' ? job.packetRevision : NaN;
  return parsePacketRef({ packageId, revision });
}

export async function loadVerifiedRevisionWithGet(
  get: (docId: string) => Promise<{ exists: boolean; data?: Record<string, unknown> }>,
  companyId: string,
  packetRef: PacketRef,
): Promise<StoreResult<{ envelope: ImmutableRevisionEnvelope; revisionDocId: string }>> {
  const docId = revisionDocId(companyId, packetRef.packageId, packetRef.revision);
  const snap = await get(docId);
  return loadVerifiedRevisionFromData(snap.exists, snap.data, companyId, packetRef);
}

export async function loadVerifiedRevision(
  companyId: string,
  packetRef: PacketRef,
): Promise<StoreResult<{ envelope: ImmutableRevisionEnvelope; revisionDocId: string }>> {
  return loadVerifiedRevisionWithGet(
    async (id) => {
      const snap = await admin.firestore().collection(REVISION_COLLECTION).doc(id).get();
      return { exists: snap.exists, data: snap.data() as Record<string, unknown> | undefined };
    },
    companyId,
    packetRef,
  );
}

export async function loadAuthorizedWellNames(): Promise<string[]> {
  const snap = await admin.database().ref('wellConfig').once('value');
  const val = snap.val();
  if (!val || typeof val !== 'object') return [];
  const names: string[] = [];
  for (const rec of Object.values(val as Record<string, unknown>)) {
    if (!rec || typeof rec !== 'object') continue;
    const wellName = (rec as { wellName?: unknown }).wellName;
    const ndic = (rec as { ndicName?: unknown }).ndicName;
    if (typeof wellName === 'string' && wellName.trim()) names.push(wellName.trim());
    if (typeof ndic === 'string' && ndic.trim()) names.push(ndic.trim());
  }
  return names;
}

export function checkWell(
  record: Record<string, unknown>,
  authorized: readonly string[],
): StoreResult<{ wellName: string }> {
  const wellName = typeof record.wellName === 'string' ? record.wellName : '';
  const ndic = typeof record.ndicWellName === 'string' ? record.ndicWellName : '';
  return evaluateWellAuthorized(wellName, ndic, authorized);
}

export function readPacketRefFromRequest(data: Record<string, unknown>): StoreResult<{ packetRef: PacketRef }> {
  return parsePacketRef(data.packetRef);
}
