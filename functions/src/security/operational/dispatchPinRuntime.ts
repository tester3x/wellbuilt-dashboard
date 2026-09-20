import * as admin from 'firebase-admin';
import {
  REVISION_COLLECTION,
  fail,
  revisionDocId,
  validateStoredRevisionForBinding,
  type ImmutableRevisionEnvelope,
  type StoreResult,
} from './jobPacketRevisionStore';
import { evaluateWellAuthorized, parsePacketRef, type PacketRef } from './dispatchPacketPin';

export async function loadVerifiedRevision(
  companyId: string,
  packetRef: PacketRef,
): Promise<StoreResult<{ envelope: ImmutableRevisionEnvelope }>> {
  const docId = revisionDocId(companyId, packetRef.packageId, packetRef.revision);
  const snap = await admin.firestore().collection(REVISION_COLLECTION).doc(docId).get();
  if (!snap.exists) return fail('revision_not_found', 'packetRef');
  const validated = validateStoredRevisionForBinding(snap.data() || {}, {
    companyId,
    packageId: packetRef.packageId,
    revision: packetRef.revision,
  });
  if (!validated.ok) return validated;
  return { ok: true, envelope: validated.envelope };
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
