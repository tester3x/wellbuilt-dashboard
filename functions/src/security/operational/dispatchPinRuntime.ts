import * as admin from 'firebase-admin';
import {
  REVISION_COLLECTION,
  revisionDocId,
  type ImmutableRevisionEnvelope,
  type StoreResult,
} from './jobPacketRevisionStore';
import {
  collectAuthorizedWellNames,
  evaluateWellAuthorized,
  loadVerifiedRevisionFromData,
  parsePacketRef,
  resolveAuthoritativeWell,
  type AuthoritativeWell,
  type AuthorizedWellCatalog,
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

export async function loadAuthorizedWellCatalog(
  actingCompanyId?: string,
): Promise<StoreResult<AuthorizedWellCatalog>> {
  const snap = await admin.database().ref('well_config').once('value');
  return collectAuthorizedWellNames(snap.exists() ? snap.val() : {}, actingCompanyId);
}

export async function loadAuthoritativeWell(
  selector: { wellName?: unknown; ndicWellName?: unknown },
  actingCompanyId?: string,
): Promise<StoreResult<{ well: AuthoritativeWell }>> {
  const snap = await admin.database().ref('well_config').once('value');
  return resolveAuthoritativeWell(snap.exists() ? snap.val() : {}, selector, actingCompanyId);
}

/** @deprecated Use loadAuthorizedWellCatalog. Kept as a name alias for call-site updates. */
export async function loadAuthorizedWellNames(actingCompanyId?: string): Promise<string[]> {
  const collected = await loadAuthorizedWellCatalog(actingCompanyId);
  if (!collected.ok) return [];
  return [...collected.names];
}

export function checkWell(
  record: Record<string, unknown>,
  authorized: readonly string[] | AuthorizedWellCatalog,
): StoreResult<{ wellName: string }> {
  const wellName = typeof record.wellName === 'string' ? record.wellName : '';
  const ndic = typeof record.ndicWellName === 'string' ? record.ndicWellName : '';
  if (Array.isArray(authorized)) {
    return evaluateWellAuthorized(wellName, ndic, authorized);
  }
  const catalog = authorized as AuthorizedWellCatalog;
  return evaluateWellAuthorized(wellName, ndic, catalog.names, catalog.ambiguous);
}

export function readPacketRefFromRequest(data: Record<string, unknown>): StoreResult<{ packetRef: PacketRef }> {
  return parsePacketRef(data.packetRef);
}
