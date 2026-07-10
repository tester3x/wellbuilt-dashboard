import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { dashboardActorRef, requireDashboardEquipmentManager } from '../auth/requireDashboard';
import { legacyEquipmentKey } from '../compatibility';
import { ActorRef, DashboardProfile } from '../types/actor';
import { buildMetadata } from '../types/metadata';
import {
  EQUIPMENT_STATUSES,
  Equipment,
  EquipmentStatus,
  EquipmentType,
  equipmentCollection,
  equipmentTypesCollection,
  reserveEquipmentId,
} from '../types/equipment';

const firestore = admin.firestore();

const PLATFORM_TYPES: Array<{ typeId: string; label: string; sortOrder: number }> = [
  { typeId: 'truck', label: 'Truck', sortOrder: 0 },
  { typeId: 'trailer', label: 'Trailer', sortOrder: 1 },
  { typeId: 'generator', label: 'Generator', sortOrder: 2 },
  { typeId: 'pump', label: 'Pump', sortOrder: 3 },
  { typeId: 'tank', label: 'Tank', sortOrder: 4 },
  { typeId: 'compressor', label: 'Compressor', sortOrder: 5 },
];

export type EquipmentAction =
  | 'registry.seedTypes'
  | 'registry.defineEquipmentType'
  | 'registry.registerEquipment'
  | 'registry.updateEquipment'
  | 'registry.getEquipment'
  | 'registry.listEquipment'
  | 'registry.resolveByUnit';

export interface EquipmentRequest {
  action: EquipmentAction;
  payload?: Record<string, unknown>;
}

export interface EquipmentRequestOptions {
  authUid?: string;
}

interface ServiceContext {
  action: EquipmentAction;
  companyId: string;
  dashboard: DashboardProfile;
  actorRef: ActorRef;
  payload: Record<string, unknown>;
}

// ── Service pipeline ───────────────────────────────────────────────────────

export async function handleEquipmentRequest(
  req: EquipmentRequest,
  options: EquipmentRequestOptions = {},
): Promise<unknown> {
  const ctx = validate(req);
  await authorize(ctx, options);
  const result = await execute(ctx);
  await publishDomainEvents(ctx, result);
  return returnResult(result);
}

function validate(req: EquipmentRequest): ServiceContext {
  if (!req?.action || !req.action.startsWith('registry.')) {
    throw new httpsV2.HttpsError('invalid-argument', 'Unsupported equipment action');
  }

  const action = req.action as EquipmentAction;
  const allowed: EquipmentAction[] = [
    'registry.seedTypes',
    'registry.defineEquipmentType',
    'registry.registerEquipment',
    'registry.updateEquipment',
    'registry.getEquipment',
    'registry.listEquipment',
    'registry.resolveByUnit',
  ];
  if (!allowed.includes(action)) {
    throw new httpsV2.HttpsError('invalid-argument', `Unknown action: ${action}`);
  }

  const companyId = String(req.payload?.companyId || '');
  if (!companyId) {
    throw new httpsV2.HttpsError('invalid-argument', 'companyId is required');
  }

  return {
    action,
    companyId,
    dashboard: { uid: '', displayName: '', roles: [], isPlatformAdmin: false },
    actorRef: { type: 'dashboard', uid: '' },
    payload: req.payload || {},
  };
}

async function authorize(ctx: ServiceContext, options: EquipmentRequestOptions): Promise<void> {
  ctx.dashboard = await requireDashboardEquipmentManager(options.authUid, ctx.companyId);
  ctx.actorRef = dashboardActorRef(ctx.dashboard);
}

async function execute(ctx: ServiceContext): Promise<unknown> {
  switch (ctx.action) {
    case 'registry.seedTypes':
      return seedPlatformTypes(ctx);
    case 'registry.defineEquipmentType':
      return defineCompanyEquipmentType(ctx);
    case 'registry.registerEquipment':
      return registerEquipment(ctx);
    case 'registry.updateEquipment':
      return updateEquipment(ctx);
    case 'registry.getEquipment':
      return getEquipment(ctx);
    case 'registry.listEquipment':
      return listEquipment(ctx);
    case 'registry.resolveByUnit':
      return resolveByUnit(ctx);
    default:
      throw new httpsV2.HttpsError('invalid-argument', `Unhandled action: ${ctx.action}`);
  }
}

async function publishDomainEvents(_ctx: ServiceContext, _result: unknown): Promise<void> {
  // Stub — future domain event bus.
}

function returnResult(result: unknown): unknown {
  return { ok: true, ...(typeof result === 'object' && result !== null ? result : { data: result }) };
}

// ── Type registry ────────────────────────────────────────────────────────────

async function seedPlatformTypes(ctx: ServiceContext): Promise<{ seeded: number; skipped: number }> {
  const col = firestore.collection(equipmentTypesCollection(ctx.companyId));
  let seeded = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const def of PLATFORM_TYPES) {
    const ref = col.doc(def.typeId);
    const existing = await ref.get();
    if (existing.exists) {
      const data = existing.data() as EquipmentType;
      if (data.source === 'company') {
        skipped++;
        continue;
      }
    }

    const meta = buildMetadata(
      ctx.actorRef,
      existing.exists ? (existing.data() as Partial<EquipmentType>) : undefined,
    );
    const record: EquipmentType = {
      typeId: def.typeId,
      companyId: ctx.companyId,
      label: def.label,
      active: true,
      sortOrder: def.sortOrder,
      source: 'platform',
      createdAt: existing.exists ? (existing.data()?.createdAt || meta.createdAt) : now,
      createdBy: existing.exists ? (existing.data()?.createdBy || meta.createdBy) : meta.createdBy,
      updatedAt: now,
      updatedBy: meta.updatedBy,
    };
    await ref.set(record, { merge: true });
    seeded++;
  }

  return { seeded, skipped };
}

async function defineCompanyEquipmentType(ctx: ServiceContext): Promise<{ type: EquipmentType }> {
  const typeId = normalizeTypeId(String(ctx.payload.typeId || ''));
  const label = String(ctx.payload.label || '').trim();
  if (!typeId) throw new httpsV2.HttpsError('invalid-argument', 'typeId is required');
  if (!label) throw new httpsV2.HttpsError('invalid-argument', 'label is required');

  const ref = firestore.collection(equipmentTypesCollection(ctx.companyId)).doc(typeId);
  const existing = await ref.get();
  const now = new Date().toISOString();
  const meta = buildMetadata(ctx.actorRef, existing.exists ? existing.data() as Partial<EquipmentType> : undefined);

  const record: EquipmentType = {
    typeId,
    companyId: ctx.companyId,
    label,
    active: ctx.payload.active !== false,
    sortOrder: typeof ctx.payload.sortOrder === 'number' ? ctx.payload.sortOrder : 100,
    source: 'company',
    icon: optionalString(ctx.payload.icon),
    createdAt: existing.exists ? (existing.data()?.createdAt || meta.createdAt) : now,
    createdBy: existing.exists ? (existing.data()?.createdBy || meta.createdBy) : meta.createdBy,
    updatedAt: now,
    updatedBy: meta.updatedBy,
  };

  await ref.set(record, { merge: false });
  return { type: record };
}

// ── Equipment registry ───────────────────────────────────────────────────────

async function registerEquipment(ctx: ServiceContext): Promise<{ equipment: Equipment }> {
  const equipmentTypeId = normalizeTypeId(String(ctx.payload.equipmentTypeId || ''));
  const unitNumber = normalizeUnitNumber(String(ctx.payload.unitNumber || ''));
  if (!equipmentTypeId) throw new httpsV2.HttpsError('invalid-argument', 'equipmentTypeId is required');
  if (!unitNumber) throw new httpsV2.HttpsError('invalid-argument', 'unitNumber is required');

  await assertEquipmentTypeExists(ctx.companyId, equipmentTypeId);
  await assertUniqueActiveUnit(ctx.companyId, equipmentTypeId, unitNumber);

  const equipmentId = reserveEquipmentId(ctx.companyId);
  const now = new Date().toISOString();
  const status = parseEquipmentStatus(ctx.payload.status) || 'ready';

  const record: Equipment = {
    equipmentId,
    companyId: ctx.companyId,
    equipmentTypeId,
    unitNumber,
    displayName: optionalString(ctx.payload.displayName),
    status,
    active: ctx.payload.active !== false,
    make: optionalString(ctx.payload.make),
    model: optionalString(ctx.payload.model),
    year: optionalString(ctx.payload.year),
    healthScore: null,
    createdAt: now,
    createdBy: ctx.actorRef,
    updatedAt: now,
    updatedBy: ctx.actorRef,
  };

  const ref = firestore.collection(equipmentCollection(ctx.companyId)).doc(equipmentId);
  await ref.set(record);
  return { equipment: record };
}

async function updateEquipment(ctx: ServiceContext): Promise<{ equipment: Equipment }> {
  const equipmentId = String(ctx.payload.equipmentId || '');
  if (!equipmentId) throw new httpsV2.HttpsError('invalid-argument', 'equipmentId is required');

  const ref = firestore.collection(equipmentCollection(ctx.companyId)).doc(equipmentId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new httpsV2.HttpsError('not-found', 'Equipment not found');
  }

  const existing = snap.data() as Equipment;
  if (existing.companyId !== ctx.companyId) {
    throw new httpsV2.HttpsError('permission-denied', 'Equipment does not belong to this company');
  }

  const unitNumber = ctx.payload.unitNumber !== undefined
    ? normalizeUnitNumber(String(ctx.payload.unitNumber))
    : existing.unitNumber;

  if (unitNumber !== existing.unitNumber) {
    const willBeActive = ctx.payload.active !== undefined ? ctx.payload.active !== false : existing.active;
    if (willBeActive) {
      await assertUniqueActiveUnit(ctx.companyId, existing.equipmentTypeId, unitNumber, equipmentId);
    }
  }

  const now = new Date().toISOString();
  const meta = buildMetadata(ctx.actorRef, existing);

  const updated: Equipment = {
    ...existing,
    unitNumber,
    displayName: ctx.payload.displayName !== undefined
      ? optionalString(ctx.payload.displayName)
      : existing.displayName,
    status: ctx.payload.status !== undefined
      ? (parseEquipmentStatus(ctx.payload.status) || existing.status)
      : existing.status,
    active: ctx.payload.active !== undefined ? ctx.payload.active !== false : existing.active,
    make: ctx.payload.make !== undefined ? optionalString(ctx.payload.make) : existing.make,
    model: ctx.payload.model !== undefined ? optionalString(ctx.payload.model) : existing.model,
    year: ctx.payload.year !== undefined ? optionalString(ctx.payload.year) : existing.year,
    healthScore: existing.healthScore ?? null,
    updatedAt: now,
    updatedBy: meta.updatedBy,
  };

  await ref.set(updated, { merge: false });
  return { equipment: updated };
}

async function getEquipment(ctx: ServiceContext): Promise<{ equipment: Equipment }> {
  const equipmentId = String(ctx.payload.equipmentId || '');
  if (!equipmentId) throw new httpsV2.HttpsError('invalid-argument', 'equipmentId is required');

  const snap = await firestore
    .collection(equipmentCollection(ctx.companyId))
    .doc(equipmentId)
    .get();

  if (!snap.exists) {
    throw new httpsV2.HttpsError('not-found', 'Equipment not found');
  }

  return { equipment: snap.data() as Equipment };
}

async function listEquipment(ctx: ServiceContext): Promise<{ equipment: Equipment[]; types: EquipmentType[] }> {
  let query: FirebaseFirestore.Query = firestore.collection(equipmentCollection(ctx.companyId));

  const equipmentTypeId = ctx.payload.equipmentTypeId
    ? normalizeTypeId(String(ctx.payload.equipmentTypeId))
    : undefined;
  if (equipmentTypeId) {
    query = query.where('equipmentTypeId', '==', equipmentTypeId);
  }

  if (ctx.payload.activeOnly === true) {
    query = query.where('active', '==', true);
  }

  const snap = await query.get();
  const equipment = snap.docs
    .map(d => d.data() as Equipment)
    .sort((a, b) => {
      if (a.equipmentTypeId !== b.equipmentTypeId) {
        return a.equipmentTypeId.localeCompare(b.equipmentTypeId);
      }
      return a.unitNumber.localeCompare(b.unitNumber);
    });

  const typesSnap = await firestore.collection(equipmentTypesCollection(ctx.companyId)).get();
  const types = typesSnap.docs.map(d => d.data() as EquipmentType);

  return { equipment, types };
}

/** Compatibility: resolve equipmentId from legacy type + unitNumber. */
async function resolveByUnit(ctx: ServiceContext): Promise<{
  equipment: Equipment | null;
  legacyKey: string;
}> {
  const equipmentTypeId = normalizeTypeId(String(ctx.payload.equipmentTypeId || ''));
  const unitNumber = normalizeUnitNumber(String(ctx.payload.unitNumber || ''));
  if (!equipmentTypeId || !unitNumber) {
    throw new httpsV2.HttpsError('invalid-argument', 'equipmentTypeId and unitNumber are required');
  }

  const legacyKey = legacyEquipmentKey(equipmentTypeId, unitNumber);
  const snap = await firestore
    .collection(equipmentCollection(ctx.companyId))
    .where('equipmentTypeId', '==', equipmentTypeId)
    .where('unitNumber', '==', unitNumber)
    .where('active', '==', true)
    .limit(1)
    .get();

  if (snap.empty) {
    return { equipment: null, legacyKey };
  }

  return { equipment: snap.docs[0].data() as Equipment, legacyKey };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function assertEquipmentTypeExists(companyId: string, typeId: string): Promise<void> {
  const ref = firestore.collection(equipmentTypesCollection(companyId)).doc(typeId);
  const snap = await ref.get();
  if (!snap.exists || (snap.data() as EquipmentType).active === false) {
    throw new httpsV2.HttpsError('failed-precondition', `Equipment type "${typeId}" is not registered for this company`);
  }
}

async function assertUniqueActiveUnit(
  companyId: string,
  equipmentTypeId: string,
  unitNumber: string,
  excludeEquipmentId?: string,
): Promise<void> {
  const snap = await firestore
    .collection(equipmentCollection(companyId))
    .where('equipmentTypeId', '==', equipmentTypeId)
    .where('unitNumber', '==', unitNumber)
    .where('active', '==', true)
    .get();

  const conflict = snap.docs.find(d => d.id !== excludeEquipmentId);
  if (conflict) {
    throw new httpsV2.HttpsError(
      'already-exists',
      `Active ${equipmentTypeId} unit "${unitNumber}" already exists (${conflict.id})`,
    );
  }
}

function normalizeUnitNumber(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeTypeId(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_');
}

function parseEquipmentStatus(value: unknown): EquipmentStatus | undefined {
  const s = String(value || '');
  return (EQUIPMENT_STATUSES as readonly string[]).includes(s) ? (s as EquipmentStatus) : undefined;
}

function optionalString(val: unknown): string | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  return String(val);
}