import * as admin from 'firebase-admin';
import * as httpsV2 from 'firebase-functions/v2/https';
import { randomUUID, createHash } from 'crypto';
import { driverAuthUid } from '../../security/tokenMint';
import { loadCanonicalDriverAuthority, productionCanonicalDriverReaders } from '../../security/canonicalDriverAuthority';
import { type ImageRef, type ProfileManifest, safeId, safeText, validateManifest, validateImageBytes } from './validation';

type Request = { auth?: { uid: string; token: Record<string, unknown> } | null; data: unknown };
type Actor = { companyId: string; canManage: boolean; uid: string };
const fs = () => admin.firestore();
// The canonical wellbuilt-sync Storage bucket is the Firebase-era .firebasestorage.app
// bucket. The older .appspot.com name does not exist in this project.
const bucket = () => admin.storage().bucket('wellbuilt-sync.firebasestorage.app');
const companyRoot = (companyId: string) => fs().collection('equipment_inspection_companies').doc(companyId);
const companyProfiles = (companyId: string) => companyRoot(companyId).collection('profiles');
const defaults = () => fs().collection('equipment_inspection_defaults');
const bad = (message: string): never => { throw new httpsV2.HttpsError('invalid-argument', message); };
const denied = (): never => { throw new httpsV2.HttpsError('permission-denied', 'Not authorized for this profile'); };
const schema = (data: unknown): Record<string, unknown> => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return bad('Invalid request');
  const value = data as Record<string, unknown>;
  if (value.schemaVersion !== 1) return bad('Unsupported schemaVersion');
  return value;
};
const manage = (actor: Actor): void => { if (!actor.canManage) denied(); };

/** Live server records decide company and edit rights. Client flags are ignored. */
export async function authorizeProfileActor(request: Request): Promise<Actor> {
  const uid = request.auth?.uid;
  if (!uid) throw new httpsV2.HttpsError('unauthenticated', 'Sign in required');
  const token = request.auth?.token || {};
  if (token.kind === 'driver') {
    const driverId = typeof token.driverId === 'string' ? token.driverId : '';
    const claimedCompany = typeof token.companyId === 'string' ? token.companyId : '';
    if (!driverId || uid !== driverAuthUid(driverId)) denied();
    const live = await loadCanonicalDriverAuthority(driverId, productionCanonicalDriverReaders());
    if (!live) return denied();
    if (!live.active || live.companyId !== claimedCompany) denied();
    const profile = await admin.database().ref(`drivers/profiles/${driverId}`).once('value');
    const roles: unknown = profile.val()?.roles;
    const canManage = Array.isArray(roles) && roles.some(role => role === 'admin' || role === 'it');
    return { companyId: safeId(live.companyId, 'companyId'), canManage, uid };
  }
  const profile = await admin.database().ref(`users/${uid}`).once('value');
  if (!profile.exists()) denied();
  const user = (profile.val() || {}) as Record<string, unknown>;
  const ownCompany = typeof user.companyId === 'string' ? user.companyId : '';
  const requested = schema(request.data).companyId;
  if (typeof requested !== 'string' || !requested) return bad('companyId required for dashboard session');
  const companyId = safeId(requested, 'companyId');
  const roles = Array.isArray(user.roles) ? user.roles : [user.role];
  if (ownCompany !== companyId) {
    if (ownCompany || !roles.some(role => role === 'it' || role === 'admin')) denied();
    const platform = await fs().collection('platform_admins').doc(uid).get();
    if (!platform.exists) denied();
  }
  const company = await fs().collection('companies').doc(companyId).get();
  if (!company.exists || company.data()?.status === 'inactive') denied();
  const overrides = (company.data()?.roleCapabilities || {}) as Record<string, string[]>;
  const caps = roles.flatMap(role => typeof role === 'string' ? (overrides[role] || (role === 'it' || role === 'admin' ? ['viewEQuipment', 'manageEquipment'] : role === 'manager' ? ['viewEQuipment'] : [])) : []);
  if (!caps.includes('viewEQuipment') && !caps.includes('manageEquipment')) denied();
  return { companyId, canManage: caps.includes('manageEquipment'), uid };
}

async function profileRef(actor: Actor, profileId: string) {
  const own = companyProfiles(actor.companyId).doc(profileId);
  if ((await own.get()).exists) return { ref: own, source: 'company' as const };
  const shared = defaults().doc(profileId);
  if ((await shared.get()).exists) return { ref: shared, source: 'wellbuilt' as const };
  throw new httpsV2.HttpsError('not-found', 'Profile not found');
}
async function listRaw(actor: Actor) {
  const [shared, own] = await Promise.all([defaults().get(), companyProfiles(actor.companyId).get()]);
  return [...shared.docs, ...own.docs].filter(doc => typeof doc.data().revision === 'string').map(doc => ({
    profileId: doc.id, title: doc.data().title, equipmentType: doc.data().equipmentType,
    revision: doc.data().revision, source: doc.ref.parent.id === 'equipment_inspection_defaults' ? 'wellbuilt' : 'company',
    supportedModes: doc.data().supportedModes,
  }));
}
async function settingsResponse(actor: Actor) {
  const [snap, available] = await Promise.all([companyRoot(actor.companyId).get(), listRaw(actor)]);
  const data = snap.data() || {};
  return { schemaVersion: 1, companyId: actor.companyId, canManage: actor.canManage,
    settingsRevision: data.settingsRevision || '0', selectedProfileIds: data.selectedProfileIds || [],
    defaultProfileId: data.defaultProfileId || null, truckAssignments: data.truckAssignments || {}, available };
}
export async function listEquipmentInspectionProfiles(request: Request) {
  schema(request.data);
  return settingsResponse(await authorizeProfileActor(request));
}
export async function getEquipmentInspectionProfile(request: Request) {
  const data = schema(request.data);
  const actor = await authorizeProfileActor(request);
  const profileId = safeId(data.profileId, 'profileId');
  const { ref, source } = await profileRef(actor, profileId);
  const current = await ref.get();
  const revision = data.revision === undefined ? safeId(current.data()?.revision, 'revision') : safeId(data.revision, 'revision');
  const version = await ref.collection('revisions').doc(revision).get();
  if (!version.exists) throw new httpsV2.HttpsError('not-found', 'Revision not found');
  const manifest = validateManifest(version.data()?.manifest, { ownerCompanyId: source === 'company' ? actor.companyId : undefined, published: true });
  const downloads: Record<string, { url: string; expiresAt: string }> = {};
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  for (const image of manifest.images) {
    const [url] = await bucket().file(image.storagePath).getSignedUrl({ action: 'read', expires: expiresAt });
    downloads[image.imageId] = { url, expiresAt: expiresAt.toISOString() };
  }
  return { schemaVersion: 1, companyId: actor.companyId, manifest, downloads };
}
export async function saveEquipmentInspectionSettings(request: Request) {
  const data = schema(request.data);
  const actor = await authorizeProfileActor(request); manage(actor);
  const expected = data.expectedRevision === '0' ? '0' : safeId(data.expectedRevision, 'expectedRevision');
  const selected = data.selectedProfileIds;
  if (!Array.isArray(selected) || selected.length > 100 || new Set(selected).size !== selected.length) bad('Invalid selectedProfileIds');
  const selectedIds = (selected as unknown[]).map((value: unknown) => safeId(value, 'profileId'));
  const allowed = new Set((await listRaw(actor)).map(item => item.profileId));
  if (selectedIds.some(value => !allowed.has(value))) bad('Unknown profile');
  const defaultId = data.defaultProfileId === null ? null : safeId(data.defaultProfileId, 'defaultProfileId');
  if (defaultId && !selectedIds.includes(defaultId)) bad('Default must be selected');
  const rawAssignments = data.truckAssignments;
  if (!rawAssignments || typeof rawAssignments !== 'object' || Array.isArray(rawAssignments)) bad('Invalid truckAssignments');
  const assignments: Record<string, string> = {};
  const entries = Object.entries(rawAssignments as Record<string, unknown>);
  if (entries.length > 1000) bad('Too many assignments');
  if (entries.length) {
    const registered = await fs().collection(`companies/${actor.companyId}/equipment`).get();
    const truckUnits = new Set(registered.docs.map(doc => doc.data()).filter(row => row.active !== false && row.equipmentTypeId === 'truck').map(row => row.unitNumber));
    if (entries.some(([unit]) => !truckUnits.has(unit))) bad('Truck assignment requires a registered active truck');
  }
  for (const [unit, value] of entries) {
    const key = safeText(unit, 'unitNumber', 80);
    if (key !== unit || assignments[key]) bad('Invalid unitNumber');
    const id = safeId(value, 'assigned profile');
    if (!selectedIds.includes(id)) bad('Assigned profile must be selected');
    assignments[key] = id;
  }
  await fs().runTransaction(async tx => {
    const ref = companyRoot(actor.companyId);
    const snap = await tx.get(ref);
    if ((snap.data()?.settingsRevision || '0') !== expected) throw new httpsV2.HttpsError('failed-precondition', 'Settings changed; reload');
    tx.set(ref, { settingsRevision: randomUUID().replace(/-/g, ''), selectedProfileIds: selectedIds,
      defaultProfileId: defaultId, truckAssignments: assignments, updatedBy: actor.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });
  return settingsResponse(actor);
}
export async function beginEquipmentInspectionPhotoUpload(request: Request) {
  const data = schema(request.data);
  const actor = await authorizeProfileActor(request); manage(actor);
  if (data.contentType !== 'image/jpeg' && data.contentType !== 'image/png') bad('Invalid contentType');
  const byteLength = data.byteLength;
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 8 * 1024 * 1024) bad('Invalid byteLength');
  if (typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256)) bad('Invalid sha256');
  const imageId = randomUUID().replace(/-/g, '');
  const storagePath = `companies/${actor.companyId}/equipment-inspection-media/${imageId}.${data.contentType === 'image/jpeg' ? 'jpg' : 'png'}`;
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const [url] = await bucket().file(storagePath).getSignedUrl({ action: 'write', expires: expiresAt,
    contentType: data.contentType as string,
    extensionHeaders: { 'x-goog-if-generation-match': '0', 'x-goog-meta-sha256': data.sha256 as string } }) as [string];
  const image = { imageId, storagePath, sha256: data.sha256, byteLength, contentType: data.contentType } as ImageRef;
  await companyRoot(actor.companyId).collection('uploads').doc(imageId).create({ ...image, createdBy: actor.uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp() });
  return { schemaVersion: 1, companyId: actor.companyId, image, upload: { url, expiresAt: expiresAt.toISOString(), method: 'PUT' } };
}
async function verifyImages(actor: Actor, manifest: ProfileManifest) {
  for (const image of manifest.images) {
    if (image.storagePath.startsWith('equipment-inspection-defaults/')) {
      const parts = image.storagePath.split('/');
      const version = await defaults().doc(parts[1]).collection('revisions').doc(parts[2]).get();
      const source = version.data()?.manifest as ProfileManifest | undefined;
      if (!source || !source.images.some(candidate => candidate.storagePath === image.storagePath && candidate.imageId === image.imageId && candidate.sha256 === image.sha256 && candidate.byteLength === image.byteLength && candidate.contentType === image.contentType)) bad('Unknown default image');
    } else {
      if (!image.storagePath.startsWith(`companies/${actor.companyId}/equipment-inspection-media/`)) denied();
      const receipt = await companyRoot(actor.companyId).collection('uploads').doc(image.imageId).get();
      if (!receipt.exists || receipt.data()?.sha256 !== image.sha256 || receipt.data()?.storagePath !== image.storagePath || receipt.data()?.byteLength !== image.byteLength || receipt.data()?.contentType !== image.contentType) bad('Unregistered image');
    }
    const [buffer] = await bucket().file(image.storagePath).download();
    if (buffer.length !== image.byteLength || createHash('sha256').update(buffer).digest('hex') !== image.sha256) bad('Image hash or size mismatch');
    validateImageBytes(buffer, image.contentType);
    const [metadata] = await bucket().file(image.storagePath).getMetadata();
    if (metadata.contentType !== image.contentType) bad('Image MIME mismatch');
  }
}
export async function saveEquipmentInspectionDraft(request: Request) {
  const data = schema(request.data);
  const actor = await authorizeProfileActor(request); manage(actor);
  const source = data.profileId === undefined ? null : safeId(data.profileId, 'profileId');
  const baseRevision = data.baseRevision === null ? null : safeId(data.baseRevision, 'baseRevision');
  if (!data.manifest || typeof data.manifest !== 'object' || Array.isArray(data.manifest)) bad('Invalid manifest');
  const submitted = data.manifest as Record<string, unknown>;
  if (submitted.source !== 'wellbuilt' && submitted.source !== 'company') bad('Invalid source');
  // A company fork may inherit a published default photo, while an existing
  // company profile keeps its own media paths. Both are company-owned drafts.
  const incoming = validateManifest({ ...submitted, source: 'company' }, { ownerCompanyId: actor.companyId });
  if (source && incoming.profileId !== source) bad('Profile identity mismatch');
  if (!source && baseRevision) bad('New profile cannot have baseRevision');
  let profileId = source || incoming.profileId;
  if (source) {
    const found = await profileRef(actor, source);
    if (found.source === 'wellbuilt') {
      const pointer = await found.ref.get();
      if (pointer.data()?.revision !== baseRevision) throw new httpsV2.HttpsError('failed-precondition', 'Default changed; reload');
      profileId = `company_${randomUUID().replace(/-/g, '')}`;
    } else if ((await found.ref.get()).data()?.revision !== baseRevision) {
      throw new httpsV2.HttpsError('failed-precondition', 'Profile changed; reload');
    }
  } else if ((await companyProfiles(actor.companyId).doc(profileId).get()).exists || (await defaults().doc(profileId).get()).exists) {
    bad('Profile ID already exists');
  }
  const revision = randomUUID().replace(/-/g, '');
  const manifest = { ...incoming, profileId, revision, source: 'company' as const,
    catalog: { ...incoming.catalog, catalogId: profileId, version: revision } };
  validateManifest(manifest, { ownerCompanyId: actor.companyId });
  const draftId = randomUUID().replace(/-/g, '');
  const draftRevision = randomUUID().replace(/-/g, '');
  await companyRoot(actor.companyId).collection('drafts').doc(draftId).create({ profileId, baseRevision: source && profileId === source ? baseRevision : null,
    manifest, draftRevision, createdBy: actor.uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  return { schemaVersion: 1, companyId: actor.companyId, draftId, draftRevision };
}
export async function publishEquipmentInspectionProfile(request: Request) {
  const data = schema(request.data);
  const actor = await authorizeProfileActor(request); manage(actor);
  const draftId = safeId(data.draftId, 'draftId');
  const expected = safeId(data.expectedDraftRevision, 'expectedDraftRevision');
  const draftRef = companyRoot(actor.companyId).collection('drafts').doc(draftId);
  const draft = await draftRef.get();
  if (!draft.exists || draft.data()?.draftRevision !== expected) throw new httpsV2.HttpsError('failed-precondition', 'Draft changed; reload');
  const manifest = validateManifest(draft.data()?.manifest, { ownerCompanyId: actor.companyId, published: true });
  await verifyImages(actor, manifest);
  const pointer = companyProfiles(actor.companyId).doc(manifest.profileId);
  await fs().runTransaction(async tx => {
    const [liveDraft, current] = await Promise.all([tx.get(draftRef), tx.get(pointer)]);
    if (!liveDraft.exists || liveDraft.data()?.draftRevision !== expected || liveDraft.data()?.publishedAt) throw new httpsV2.HttpsError('failed-precondition', 'Draft already published or changed');
    if ((current.data()?.revision || null) !== (liveDraft.data()?.baseRevision || null)) throw new httpsV2.HttpsError('failed-precondition', 'Profile changed; reload');
    const version = pointer.collection('revisions').doc(manifest.revision);
    tx.create(version, { manifest, publishedBy: actor.uid, publishedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(pointer, { revision: manifest.revision, title: manifest.title, equipmentType: manifest.equipmentType,
      source: 'company', supportedModes: manifest.supportedModes, publishedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    tx.update(draftRef, { publishedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
  return { schemaVersion: 1, companyId: actor.companyId, profileId: manifest.profileId, revision: manifest.revision };
}
