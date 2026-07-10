import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireDriver } from '../auth/requireDriver';
import { ActorRef, DriverActor, DriverProfile } from '../types/actor';
import { buildMetadata } from '../types/metadata';
import { Assignment, assignmentsCollection } from '../types/assignment';
import {
  InspectionCategoryRecord,
  InspectionItemResult,
  PRE_TRIP_CATEGORY_IDS,
  PRE_TRIP_CATEGORY_LABELS,
  PreTripCategoryId,
  PreTripInspectionRecord,
  dvirInspectionsCollection,
  reserveInspectionId,
} from '../types/dvir';

const firestore = admin.firestore();

export type DvirAction = 'dvir.submitPreTrip';

export interface DvirRequest {
  actor?: DriverActor;
  action: DvirAction;
  payload?: Record<string, unknown>;
}

export interface DvirRequestOptions {
  authUid?: string;
}

interface ServiceContext {
  action: DvirAction;
  companyId: string;
  actor: DriverActor;
  driver: DriverProfile;
  actorRef: ActorRef;
  payload: Record<string, unknown>;
}

interface ServiceResult {
  data: unknown;
}

// ── Service pipeline ───────────────────────────────────────────────────────

export async function handleDvirRequest(
  req: DvirRequest,
  options: DvirRequestOptions = {},
): Promise<unknown> {
  const ctx = await validate(req, options);
  const result = await execute(ctx);
  return result.data;
}

async function validate(req: DvirRequest, _options: DvirRequestOptions): Promise<ServiceContext> {
  if (!req?.action || !req.action.startsWith('dvir.')) {
    throw new httpsV2.HttpsError('invalid-argument', 'Unsupported DVIR action');
  }

  const action = req.action as DvirAction;
  if (action !== 'dvir.submitPreTrip') {
    throw new httpsV2.HttpsError('invalid-argument', `Unknown action: ${action}`);
  }

  if (!req.actor || req.actor.type !== 'driver') {
    throw new httpsV2.HttpsError('invalid-argument', 'driver actor is required');
  }

  const companyId = String(req.payload?.companyId || '');
  if (!companyId) {
    throw new httpsV2.HttpsError('invalid-argument', 'companyId is required');
  }

  const driver = await requireDriver(req.actor);
  if (driver.companyId && driver.companyId !== companyId) {
    throw new httpsV2.HttpsError('permission-denied', 'Driver does not belong to this company');
  }

  const requestedHash = req.payload?.driverHash
    ? String(req.payload.driverHash).trim().toLowerCase()
    : driver.driverHash;
  if (requestedHash !== driver.driverHash) {
    throw new httpsV2.HttpsError('permission-denied', 'driverHash must match authenticated driver');
  }

  return {
    action,
    companyId,
    actor: req.actor,
    driver,
    actorRef: { type: 'driver', driverHash: driver.driverHash, displayName: driver.displayName },
    payload: req.payload || {},
  };
}

async function execute(ctx: ServiceContext): Promise<ServiceResult> {
  switch (ctx.action) {
    case 'dvir.submitPreTrip':
      return submitPreTrip(ctx);
    default:
      throw new httpsV2.HttpsError('invalid-argument', `Unhandled action: ${ctx.action}`);
  }
}

async function submitPreTrip(ctx: ServiceContext): Promise<ServiceResult> {
  const equipmentId = String(ctx.payload.equipmentId || '');
  if (!equipmentId) {
    throw new httpsV2.HttpsError('invalid-argument', 'equipmentId is required');
  }

  const assignmentSource = ctx.payload.assignmentSource === 'legacy' ? 'legacy' : 'canonical';
  const assignmentId = optionalString(ctx.payload.assignmentId) ?? null;
  const driverSignature = String(ctx.payload.driverSignature || '').trim();
  if (!driverSignature) {
    throw new httpsV2.HttpsError('invalid-argument', 'driverSignature is required');
  }

  const startedAt = String(ctx.payload.startedAt || '');
  if (!startedAt) {
    throw new httpsV2.HttpsError('invalid-argument', 'startedAt is required');
  }

  const categories = parseCategories(ctx.payload.categories);
  const overallResult = computeOverallResult(categories);

  await assertDriverCustody(ctx, equipmentId, assignmentId, assignmentSource);

  const inspectionId = reserveInspectionId(ctx.companyId);
  const submittedAt = new Date().toISOString();
  const meta = buildMetadata(ctx.actorRef);

  const record: PreTripInspectionRecord = {
    inspectionId,
    companyId: ctx.companyId,
    equipmentId,
    assignmentId,
    assignmentSource,
    driverHash: ctx.driver.driverHash,
    driverDisplayName: optionalString(ctx.payload.driverDisplayName) || ctx.driver.displayName,
    equipmentLabel: optionalString(ctx.payload.equipmentLabel),
    assignmentRole: optionalString(ctx.payload.assignmentRole) ?? undefined,
    inspectionType: 'pre_trip',
    status: 'submitted',
    overallResult,
    categories,
    driverSignature,
    startedAt,
    submittedAt,
    ...meta,
  };

  await firestore
    .collection(dvirInspectionsCollection(ctx.companyId))
    .doc(inspectionId)
    .set(record);

  return {
    data: {
      ok: true,
      inspectionId,
      overallResult,
      submittedAt,
    },
  };
}

function parseCategories(raw: unknown): InspectionCategoryRecord[] {
  if (!Array.isArray(raw)) {
    throw new httpsV2.HttpsError('invalid-argument', 'categories array is required');
  }

  const byId = new Map<PreTripCategoryId, InspectionItemResult>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const categoryId = String((entry as Record<string, unknown>).categoryId || '') as PreTripCategoryId;
    const result = String((entry as Record<string, unknown>).result || '') as InspectionItemResult;
    if (!PRE_TRIP_CATEGORY_IDS.includes(categoryId)) continue;
    if (result !== 'pass' && result !== 'needs_attention') {
      throw new httpsV2.HttpsError('invalid-argument', `Invalid result for ${categoryId}`);
    }
    byId.set(categoryId, result);
  }

  if (byId.size !== PRE_TRIP_CATEGORY_IDS.length) {
    throw new httpsV2.HttpsError('invalid-argument', 'All inspection categories must be completed');
  }

  return PRE_TRIP_CATEGORY_IDS.map((categoryId) => ({
    categoryId,
    categoryLabel: PRE_TRIP_CATEGORY_LABELS[categoryId],
    result: byId.get(categoryId)!,
  }));
}

function computeOverallResult(categories: InspectionCategoryRecord[]): InspectionItemResult {
  return categories.some((c) => c.result === 'needs_attention') ? 'needs_attention' : 'pass';
}

async function assertDriverCustody(
  ctx: ServiceContext,
  equipmentId: string,
  assignmentId: string | null,
  assignmentSource: 'canonical' | 'legacy',
): Promise<void> {
  if (assignmentSource === 'legacy' || equipmentId.startsWith('legacy_')) {
    return;
  }

  if (assignmentId) {
    const assignmentRef = firestore
      .collection(assignmentsCollection(ctx.companyId))
      .doc(assignmentId);
    const snap = await assignmentRef.get();
    if (!snap.exists) {
      throw new httpsV2.HttpsError('permission-denied', 'Assignment not found');
    }
    const assignment = snap.data() as Assignment;
    if (
      !assignment.active
      || assignment.driverHash !== ctx.driver.driverHash
      || assignment.equipmentId !== equipmentId
    ) {
      throw new httpsV2.HttpsError('permission-denied', 'No active assignment for this equipment');
    }
    return;
  }

  const activeSnap = await firestore
    .collection(assignmentsCollection(ctx.companyId))
    .where('equipmentId', '==', equipmentId)
    .where('driverHash', '==', ctx.driver.driverHash)
    .where('active', '==', true)
    .limit(1)
    .get();

  if (activeSnap.empty) {
    throw new httpsV2.HttpsError('permission-denied', 'No active assignment for this equipment');
  }
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}