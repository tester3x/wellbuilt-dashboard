import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireDriver } from '../auth/requireDriver';
import {
  dashboardActorRef,
  requireDashboardAssignmentManager,
} from '../auth/requireDashboardAssignments';
import { ActorRef, DriverActor, DriverProfile, DashboardProfile } from '../types/actor';
import { buildMetadata } from '../types/metadata';
import { Equipment, equipmentCollection } from '../types/equipment';
import {
  ASSIGNMENT_RESTRICTED_EQUIPMENT_STATUSES,
  ASSIGNMENT_ROLES,
  Assignment,
  AssignmentDomainEvent,
  AssignmentRole,
  assignmentsCollection,
  reserveAssignmentId,
} from '../types/assignment';

const firestore = admin.firestore();

export type AssignmentAction =
  | 'assignment.start'
  | 'assignment.end'
  | 'assignment.transfer'
  | 'assignment.getActiveForEquipment'
  | 'assignment.listActiveForDriver'
  | 'assignment.listForCompany'
  | 'assignment.listHistoryForEquipment'
  | 'assignment.listHistoryForDriver';

export interface AssignmentRequest {
  actor?: DriverActor;
  action: AssignmentAction;
  payload?: Record<string, unknown>;
}

export interface AssignmentRequestOptions {
  authUid?: string;
}

type ServiceMode = 'driver' | 'dashboard';

interface ServiceContext {
  mode: ServiceMode;
  action: AssignmentAction;
  companyId: string;
  actor?: DriverActor;
  driver?: DriverProfile;
  dashboard?: DashboardProfile;
  actorRef: ActorRef;
  payload: Record<string, unknown>;
  authUid?: string;
}

interface ServiceResult {
  data: unknown;
  events: AssignmentDomainEvent[];
}

const DRIVER_READ_ACTIONS = new Set<AssignmentAction>([
  'assignment.listActiveForDriver',
]);

// ── Service pipeline ───────────────────────────────────────────────────────

export async function handleAssignmentRequest(
  req: AssignmentRequest,
  options: AssignmentRequestOptions = {},
): Promise<unknown> {
  const ctx = validate(req, options);
  await authorize(ctx);
  const result = await execute(ctx);
  await publishDomainEvents(ctx, result);
  return returnResult(result);
}

function validate(req: AssignmentRequest, options: AssignmentRequestOptions): ServiceContext {
  if (!req?.action || !req.action.startsWith('assignment.')) {
    throw new httpsV2.HttpsError('invalid-argument', 'Unsupported assignment action');
  }

  const action = req.action as AssignmentAction;
  const allowed: AssignmentAction[] = [
    'assignment.start',
    'assignment.end',
    'assignment.transfer',
    'assignment.getActiveForEquipment',
    'assignment.listActiveForDriver',
    'assignment.listForCompany',
    'assignment.listHistoryForEquipment',
    'assignment.listHistoryForDriver',
  ];
  if (!allowed.includes(action)) {
    throw new httpsV2.HttpsError('invalid-argument', `Unknown action: ${action}`);
  }

  const companyId = String(req.payload?.companyId || '');
  if (!companyId) {
    throw new httpsV2.HttpsError('invalid-argument', 'companyId is required');
  }

  if (DRIVER_READ_ACTIONS.has(action)) {
    if (!req.actor || req.actor.type !== 'driver') {
      throw new httpsV2.HttpsError('invalid-argument', 'driver actor is required for assignment.listActiveForDriver');
    }
    return {
      mode: 'driver',
      action,
      companyId,
      actor: req.actor,
      actorRef: { type: 'driver', driverHash: req.actor.driverHash.trim().toLowerCase() },
      payload: req.payload || {},
    };
  }

  return {
    mode: 'dashboard',
    action,
    companyId,
    actorRef: { type: 'dashboard', uid: options.authUid || '' },
    payload: req.payload || {},
    authUid: options.authUid,
  };
}

async function authorize(ctx: ServiceContext): Promise<void> {
  if (ctx.mode === 'driver' && ctx.actor) {
    ctx.driver = await requireDriver(ctx.actor);
    if (ctx.driver.companyId && ctx.driver.companyId !== ctx.companyId) {
      throw new httpsV2.HttpsError('permission-denied', 'Driver does not belong to this company');
    }
    const requestedHash = ctx.payload.driverHash
      ? normalizeDriverHash(String(ctx.payload.driverHash))
      : ctx.driver.driverHash;
    if (requestedHash !== ctx.driver.driverHash) {
      throw new httpsV2.HttpsError('permission-denied', 'driverHash must match authenticated driver');
    }
    ctx.actorRef = {
      type: 'driver',
      driverHash: ctx.driver.driverHash,
      displayName: ctx.driver.displayName,
    };
    return;
  }

  ctx.dashboard = await requireDashboardAssignmentManager(ctx.authUid, ctx.companyId);
  ctx.actorRef = dashboardActorRef(ctx.dashboard);
}

async function execute(ctx: ServiceContext): Promise<ServiceResult> {
  switch (ctx.action) {
    case 'assignment.start':
      return startAssignment(ctx);
    case 'assignment.end':
      return endAssignment(ctx);
    case 'assignment.transfer':
      return transferAssignment(ctx);
    case 'assignment.getActiveForEquipment':
      return getActiveForEquipment(ctx);
    case 'assignment.listActiveForDriver':
      return listActiveForDriver(ctx);
    case 'assignment.listForCompany':
      return listForCompany(ctx);
    case 'assignment.listHistoryForEquipment':
      return listHistoryForEquipment(ctx);
    case 'assignment.listHistoryForDriver':
      return listHistoryForDriver(ctx);
    default:
      throw new httpsV2.HttpsError('invalid-argument', `Unhandled action: ${ctx.action}`);
  }
}

async function publishDomainEvents(_ctx: ServiceContext, result: ServiceResult): Promise<void> {
  // Stub — events returned in response for future event bus wiring.
  void result.events;
}

function returnResult(result: ServiceResult): unknown {
  const data = typeof result.data === 'object' && result.data !== null
    ? result.data
    : { data: result.data };
  return { ok: true, ...data, events: result.events };
}

// ── Write actions ─────────────────────────────────────────────────────────────

async function startAssignment(ctx: ServiceContext): Promise<ServiceResult> {
  const equipmentId = String(ctx.payload.equipmentId || '');
  const driverHash = normalizeDriverHash(String(ctx.payload.driverHash || ''));
  if (!equipmentId) throw new httpsV2.HttpsError('invalid-argument', 'equipmentId is required');
  if (!driverHash) throw new httpsV2.HttpsError('invalid-argument', 'driverHash is required');

  const role = parseAssignmentRole(ctx.payload.role) || 'primary_operator';
  const assignmentId = ctx.payload.assignmentId
    ? String(ctx.payload.assignmentId)
    : reserveAssignmentId(ctx.companyId);

  await assertDriverBelongsToCompany(driverHash, ctx.companyId);

  const col = firestore.collection(assignmentsCollection(ctx.companyId));

  const { assignment, created } = await firestore.runTransaction(async (tx) => {
    const newRef = col.doc(assignmentId);
    const existingNew = await tx.get(newRef);
    if (existingNew.exists) {
      const existing = existingNew.data() as Assignment;
      if (
        existing.active
        && existing.equipmentId === equipmentId
        && existing.driverHash === driverHash
        && existing.companyId === ctx.companyId
      ) {
        return { assignment: existing, created: false };
      }
      throw new httpsV2.HttpsError('already-exists', 'assignmentId already in use with different custody');
    }

    const equipment = await loadEquipmentForAssignment(tx, ctx.companyId, equipmentId, ctx.payload);
    void equipment;

    const activeSnap = await tx.get(
      col.where('equipmentId', '==', equipmentId).where('active', '==', true).limit(1),
    );
    if (!activeSnap.empty) {
      throw new httpsV2.HttpsError(
        'failed-precondition',
        'Equipment already has an active assignment. End or transfer custody first.',
      );
    }

    const now = new Date().toISOString();
    const record: Assignment = {
      assignmentId,
      companyId: ctx.companyId,
      equipmentId,
      driverHash,
      assignedBy: ctx.actorRef,
      role,
      active: true,
      startedAt: typeof ctx.payload.startedAt === 'string' ? ctx.payload.startedAt : now,
      notes: optionalString(ctx.payload.notes),
      createdAt: now,
      createdBy: ctx.actorRef,
      updatedAt: now,
      updatedBy: ctx.actorRef,
    };

    tx.set(newRef, record);
    return { assignment: record, created: true };
  });

  const events: AssignmentDomainEvent[] = created
    ? [{
        type: 'EquipmentAssigned',
        companyId: ctx.companyId,
        assignmentId: assignment.assignmentId,
        equipmentId: assignment.equipmentId,
        driverHash: assignment.driverHash,
      }]
    : [];

  return { data: { assignment }, events };
}

async function endAssignment(ctx: ServiceContext): Promise<ServiceResult> {
  const assignmentId = String(ctx.payload.assignmentId || '');
  if (!assignmentId) throw new httpsV2.HttpsError('invalid-argument', 'assignmentId is required');

  const col = firestore.collection(assignmentsCollection(ctx.companyId));

  const { assignment, ended } = await firestore.runTransaction(async (tx) => {
    const ref = col.doc(assignmentId);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new httpsV2.HttpsError('not-found', 'Assignment not found');
    }

    const existing = snap.data() as Assignment;
    if (existing.companyId !== ctx.companyId) {
      throw new httpsV2.HttpsError('permission-denied', 'Assignment does not belong to this company');
    }

    if (!existing.active) {
      return { assignment: existing, ended: false };
    }

    const now = new Date().toISOString();
    const endedAt = typeof ctx.payload.endedAt === 'string' ? ctx.payload.endedAt : now;
    const meta = buildMetadata(ctx.actorRef, existing);
    const record: Assignment = {
      ...existing,
      active: false,
      endedAt,
      notes: ctx.payload.notes !== undefined ? optionalString(ctx.payload.notes) : existing.notes,
      updatedAt: now,
      updatedBy: meta.updatedBy,
    };

    tx.set(ref, record, { merge: false });
    return { assignment: record, ended: true };
  });

  const events: AssignmentDomainEvent[] = ended
    ? [{
        type: 'EquipmentAssignmentEnded',
        companyId: ctx.companyId,
        assignmentId: assignment.assignmentId,
        equipmentId: assignment.equipmentId,
        driverHash: assignment.driverHash,
      }]
    : [];

  return { data: { assignment }, events };
}

async function transferAssignment(ctx: ServiceContext): Promise<ServiceResult> {
  const equipmentId = String(ctx.payload.equipmentId || '');
  const driverHash = normalizeDriverHash(String(ctx.payload.driverHash || ''));
  if (!equipmentId) throw new httpsV2.HttpsError('invalid-argument', 'equipmentId is required');
  if (!driverHash) throw new httpsV2.HttpsError('invalid-argument', 'driverHash is required');

  const role = parseAssignmentRole(ctx.payload.role) || 'primary_operator';
  const newAssignmentId = ctx.payload.newAssignmentId
    ? String(ctx.payload.newAssignmentId)
    : reserveAssignmentId(ctx.companyId);

  await assertDriverBelongsToCompany(driverHash, ctx.companyId);

  const col = firestore.collection(assignmentsCollection(ctx.companyId));

  const { result, transferred } = await firestore.runTransaction(async (tx) => {
    const newRef = col.doc(newAssignmentId);
    const existingNew = await tx.get(newRef);

    const activeSnap = await tx.get(
      col.where('equipmentId', '==', equipmentId).where('active', '==', true).limit(1),
    );

    if (existingNew.exists) {
      const newData = existingNew.data() as Assignment;
      if (
        newData.active
        && newData.equipmentId === equipmentId
        && newData.driverHash === driverHash
        && newData.companyId === ctx.companyId
      ) {
        const previousId = String(ctx.payload.previousAssignmentId || '');
        if (previousId) {
          const prevRef = col.doc(previousId);
          const prevSnap = await tx.get(prevRef);
          if (prevSnap.exists && !(prevSnap.data() as Assignment).active) {
            return { result: { previous: prevSnap.data() as Assignment, current: newData }, transferred: false };
          }
        }
        return { result: { previous: null, current: newData }, transferred: false };
      }
      throw new httpsV2.HttpsError('already-exists', 'newAssignmentId already in use with different custody');
    }

    if (activeSnap.empty) {
      throw new httpsV2.HttpsError('failed-precondition', 'No active assignment to transfer from');
    }

    const currentRef = activeSnap.docs[0].ref;
    const currentSnap = await tx.get(currentRef);
    const current = currentSnap.data() as Assignment;

    if (current.driverHash === driverHash) {
      throw new httpsV2.HttpsError('failed-precondition', 'Equipment is already assigned to this driver');
    }

    await loadEquipmentForAssignment(tx, ctx.companyId, equipmentId, ctx.payload);

    const now = new Date().toISOString();
    const meta = buildMetadata(ctx.actorRef, current);
    const ended: Assignment = {
      ...current,
      active: false,
      endedAt: now,
      updatedAt: now,
      updatedBy: meta.updatedBy,
    };

    const created: Assignment = {
      assignmentId: newAssignmentId,
      companyId: ctx.companyId,
      equipmentId,
      driverHash,
      assignedBy: ctx.actorRef,
      role,
      active: true,
      startedAt: now,
      notes: optionalString(ctx.payload.notes),
      createdAt: now,
      createdBy: ctx.actorRef,
      updatedAt: now,
      updatedBy: ctx.actorRef,
    };

    tx.set(currentRef, ended, { merge: false });
    tx.set(newRef, created, { merge: false });

    return { result: { previous: ended, current: created }, transferred: true };
  });

  const events: AssignmentDomainEvent[] = transferred && result.previous
    ? [
        {
          type: 'EquipmentAssignmentEnded',
          companyId: ctx.companyId,
          assignmentId: result.previous.assignmentId,
          equipmentId: result.previous.equipmentId,
          driverHash: result.previous.driverHash,
        },
        {
          type: 'EquipmentTransferred',
          companyId: ctx.companyId,
          equipmentId,
          previousAssignmentId: result.previous.assignmentId,
          newAssignmentId: result.current.assignmentId,
          previousDriverHash: result.previous.driverHash,
          newDriverHash: result.current.driverHash,
        },
        {
          type: 'EquipmentAssigned',
          companyId: ctx.companyId,
          assignmentId: result.current.assignmentId,
          equipmentId: result.current.equipmentId,
          driverHash: result.current.driverHash,
        },
      ]
    : [];

  return { data: { previous: result.previous, assignment: result.current }, events };
}

// ── Read actions ─────────────────────────────────────────────────────────────

async function getActiveForEquipment(ctx: ServiceContext): Promise<ServiceResult> {
  const equipmentId = String(ctx.payload.equipmentId || '');
  if (!equipmentId) throw new httpsV2.HttpsError('invalid-argument', 'equipmentId is required');

  const snap = await firestore
    .collection(assignmentsCollection(ctx.companyId))
    .where('equipmentId', '==', equipmentId)
    .where('active', '==', true)
    .limit(1)
    .get();

  return {
    data: { assignment: snap.empty ? null : (snap.docs[0].data() as Assignment) },
    events: [],
  };
}

async function listActiveForDriver(ctx: ServiceContext): Promise<ServiceResult> {
  const driverHash = ctx.mode === 'driver'
    ? ctx.driver!.driverHash
    : normalizeDriverHash(String(ctx.payload.driverHash || ''));
  if (!driverHash) throw new httpsV2.HttpsError('invalid-argument', 'driverHash is required');

  if (ctx.mode === 'dashboard') {
    await assertDriverBelongsToCompany(driverHash, ctx.companyId);
  }

  const snap = await firestore
    .collection(assignmentsCollection(ctx.companyId))
    .where('driverHash', '==', driverHash)
    .where('active', '==', true)
    .get();

  const assignments = snap.docs
    .map((d) => d.data() as Assignment)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return { data: { assignments }, events: [] };
}

async function listForCompany(ctx: ServiceContext): Promise<ServiceResult> {
  const snap = await firestore
    .collection(assignmentsCollection(ctx.companyId))
    .where('active', '==', true)
    .get();

  const assignments = snap.docs
    .map((d) => d.data() as Assignment)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return { data: { assignments }, events: [] };
}

async function listHistoryForEquipment(ctx: ServiceContext): Promise<ServiceResult> {
  const equipmentId = String(ctx.payload.equipmentId || '');
  if (!equipmentId) throw new httpsV2.HttpsError('invalid-argument', 'equipmentId is required');

  const snap = await firestore
    .collection(assignmentsCollection(ctx.companyId))
    .where('equipmentId', '==', equipmentId)
    .orderBy('startedAt', 'desc')
    .get();

  return {
    data: { assignments: snap.docs.map((d) => d.data() as Assignment) },
    events: [],
  };
}

async function listHistoryForDriver(ctx: ServiceContext): Promise<ServiceResult> {
  const driverHash = normalizeDriverHash(String(ctx.payload.driverHash || ''));
  if (!driverHash) throw new httpsV2.HttpsError('invalid-argument', 'driverHash is required');

  await assertDriverBelongsToCompany(driverHash, ctx.companyId);

  const snap = await firestore
    .collection(assignmentsCollection(ctx.companyId))
    .where('driverHash', '==', driverHash)
    .orderBy('startedAt', 'desc')
    .get();

  return {
    data: { assignments: snap.docs.map((d) => d.data() as Assignment) },
    events: [],
  };
}

// ── Validation helpers ────────────────────────────────────────────────────────

async function loadEquipmentForAssignment(
  tx: FirebaseFirestore.Transaction,
  companyId: string,
  equipmentId: string,
  payload: Record<string, unknown>,
): Promise<Equipment> {
  const ref = firestore.collection(equipmentCollection(companyId)).doc(equipmentId);
  const snap = await tx.get(ref);
  if (!snap.exists) {
    throw new httpsV2.HttpsError('not-found', 'Equipment not found');
  }

  const equipment = snap.data() as Equipment;
  if (equipment.companyId !== companyId) {
    throw new httpsV2.HttpsError('permission-denied', 'Equipment does not belong to this company');
  }
  if (!equipment.active) {
    throw new httpsV2.HttpsError('failed-precondition', 'Cannot assign inactive equipment');
  }

  const restricted = ASSIGNMENT_RESTRICTED_EQUIPMENT_STATUSES as readonly string[];
  if (restricted.includes(equipment.status)) {
    const override = payload.overrideRestrictedStatus === true;
    const reason = optionalString(payload.overrideReason);
    if (!override || !reason) {
      throw new httpsV2.HttpsError(
        'failed-precondition',
        `Equipment status "${equipment.status}" requires overrideRestrictedStatus and overrideReason`,
      );
    }
  }

  return equipment;
}

async function assertDriverBelongsToCompany(driverHash: string, companyId: string): Promise<DriverProfile> {
  const driver = await requireDriver({ type: 'driver', driverHash });
  if (!driver.companyId || driver.companyId !== companyId) {
    throw new httpsV2.HttpsError('failed-precondition', 'Driver does not belong to this company');
  }
  return driver;
}

export async function hasActiveAssignmentForEquipment(companyId: string, equipmentId: string): Promise<boolean> {
  const snap = await firestore
    .collection(assignmentsCollection(companyId))
    .where('equipmentId', '==', equipmentId)
    .where('active', '==', true)
    .limit(1)
    .get();
  return !snap.empty;
}

function normalizeDriverHash(value: string): string {
  return value.trim().toLowerCase();
}

function parseAssignmentRole(value: unknown): AssignmentRole | undefined {
  const role = String(value || '');
  return (ASSIGNMENT_ROLES as readonly string[]).includes(role) ? (role as AssignmentRole) : undefined;
}

function optionalString(val: unknown): string | undefined {
  if (val === undefined || val === null || val === '') return undefined;
  return String(val);
}