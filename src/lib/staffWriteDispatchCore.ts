/**
 * Firebase-free CORE for governed Dashboard dispatch writes.
 *
 * Holds payload serialization (jsonSafe), wire payload builders, and the
 * DispatchCreationCoordinator governing client-side creation lifecycle:
 * - Explicit action/batch identity (beginAction, finalizeAction, cancelAction)
 * - Stable logical unit identity per slot/split
 * - Idempotent partial-batch retry (successful units are never recreated under new IDs)
 * - Monotonic generation tokens protecting against stale completion overwrite
 * - Tenant and user session isolation (per-session ownership, reset on auth change)
 * - Safe memory bounding (never evict pending/uncertain by age/capacity; prune on finalize/cancel)
 */

/** The deployed callable all three dispatch write ops target. */
export const STAFF_WRITE_DISPATCH_CALLABLE = 'staffWriteDispatch';

const SERVER_AUTHORITATIVE = new Set(['assignedAt', 'companyId']);
const DECLINE_FIELDS = new Set(['declinedAt', 'declineReason', 'declinedBy']);

function isTimestampLike(val: unknown): val is { toMillis: () => number } {
  return !!val && typeof val === 'object' && typeof (val as { toMillis?: unknown }).toMillis === 'function';
}

/**
 * Serialize a staff dispatch payload.
 * assignedAt/companyId are omitted so the server stamps/derives them.
 * Any other Timestamp-like value is serialized — never silently dropped.
 * Decline fields are rejected (server owns the decline lifecycle).
 */
export function jsonSafe(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    if (val === undefined) continue;
    if (DECLINE_FIELDS.has(key)) {
      throw new Error(`decline_fields_immutable:${key}`);
    }
    if (isTimestampLike(val)) {
      if (SERVER_AUTHORITATIVE.has(key)) continue;
      const ms = val.toMillis();
      out[key] = { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 };
      continue;
    }
    out[key] = val;
  }
  return out;
}

export type CallableInvoker = (payload: unknown) => Promise<{ data: unknown }>;

/**
 * Mint a client-side stable dispatch ID at deliberate creation boundary.
 */
export function mintDispatchId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'disp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

/**
 * Compute canonical unit key for an intended dispatch unit.
 * Multi-leg splits and multi-well dispatches naturally produce distinct unit keys.
 */
export function computeCreationUnitKey(record: Record<string, unknown>, unitKeyOverride?: string): string {
  if (unitKeyOverride && unitKeyOverride.trim()) {
    return unitKeyOverride.trim();
  }
  const well = typeof record.wellName === 'string' ? record.wellName.trim().toLowerCase() : '';
  const driver = typeof record.driverId === 'string' && record.driverId.trim()
    ? record.driverId.trim().toLowerCase()
    : (typeof record.driverHash === 'string' ? record.driverHash.trim().toLowerCase() : '');
  const jobType = typeof record.jobType === 'string' ? record.jobType.trim().toLowerCase() : '';
  const serviceType = typeof record.serviceType === 'string' ? record.serviceType.trim().toLowerCase() : '';
  const splitGroup = typeof record.splitGroupId === 'string' ? record.splitGroupId.trim() : '';
  const splitSeq = typeof record.splitSequence === 'number' ? String(record.splitSequence) : '';
  const project = typeof record.projectId === 'string' ? record.projectId.trim() : '';

  return [well, driver, jobType, serviceType, splitGroup, splitSeq, project].join('::');
}

/**
 * Check if two records share identical material immutable birth fields.
 * Any change to well, driver, jobType, serviceType, packageId, split parameters,
 * disposal, or load count constitutes a new deliberate creation action.
 */
export function materialBirthFieldsMatch(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const numOrZero = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  if (norm(a.wellName) !== norm(b.wellName)) return false;
  if (norm(a.driverHash) !== norm(b.driverHash)) return false;
  if (norm(a.driverId) !== norm(b.driverId)) return false;
  if (norm(a.jobType) !== norm(b.jobType)) return false;
  if (norm(a.serviceType) !== norm(b.serviceType)) return false;
  if (norm(a.packageId) !== norm(b.packageId)) return false;
  if (norm(a.splitGroupId) !== norm(b.splitGroupId)) return false;
  if (numOrZero(a.splitSequence) !== numOrZero(b.splitSequence)) return false;
  if (norm(a.projectId) !== norm(b.projectId)) return false;
  if (norm(a.disposal) !== norm(b.disposal)) return false;
  if (numOrZero(a.loadCount) !== numOrZero(b.loadCount)) return false;

  return true;
}

export type UnitStatus =
  | 'pending'
  | 'in_flight'
  | 'succeeded'
  | 'failed-known'
  | 'failed-uncertain'
  | 'canceled';

export interface ActionUnitState {
  actionId: string;
  unitId: string;
  dispatchId: string;
  payloadRecord: Record<string, unknown>;
  status: UnitStatus;
  createdAt: number;
  updatedAt: number;
  currentRequestId: number;
  inFlightPromise?: Promise<{ dispatchId: string }>;
  lastError?: unknown;
  result?: { dispatchId: string };
}

export interface ActionBatchState {
  actionId: string;
  actionScope: string;
  tenantId?: string;
  userId?: string;
  createdAt: number;
  finalizedAt?: number;
  status: 'active' | 'finalized' | 'canceled';
  units: Map<string, ActionUnitState>;
}

export interface CoordinatorOptions {
  tenantId?: string;
  userId?: string;
}

export interface BeginActionOptions {
  actionId?: string;
  actionScope?: string;
  tenantId?: string;
  userId?: string;
  batchId?: string;
}

export interface ExecuteUnitOptions {
  actionId?: string;
  actionScope?: string;
  unitId?: string;
  unitKey?: string;
  tenantId?: string;
  userId?: string;
  forceReplay?: boolean;
}

export interface RetainedCreationRequest {
  dispatchId: string;
  unitKey: string;
  payloadRecord: Record<string, unknown>;
  createdAt: number;
  status: 'idle' | 'in_flight' | 'uncertain_error' | 'succeeded';
  inFlightPromise?: Promise<{ dispatchId: string }>;
  lastError?: unknown;
  actionId?: string;
  unitId?: string;
}

/**
 * Coordinates creation actions, ensuring explicit action/batch lifecycle,
 * stable unit identity, idempotency on partial success, and safe memory bounds.
 */
export class DispatchCreationCoordinator {
  public sessionTenantId?: string;
  public sessionUserId?: string;
  public sessionKey: string;

  private actions = new Map<string, ActionBatchState>();
  private unitKeyIndex = new Map<string, { actionId: string; unitId: string }>();

  constructor(options?: CoordinatorOptions) {
    this.sessionTenantId = options?.tenantId;
    this.sessionUserId = options?.userId;
    this.sessionKey = `${this.sessionUserId || 'anon'}::${this.sessionTenantId || 'nocompany'}`;
  }

  /**
   * Resets the coordinator for a new authenticated session (UID / companyId change or sign-out).
   * Prunes all retained actions and rebinds session keys.
   */
  resetAuthenticatedSession(tenantId?: string, userId?: string): void {
    this.actions.clear();
    this.unitKeyIndex.clear();
    this.sessionTenantId = tenantId;
    this.sessionUserId = userId;
    this.sessionKey = `${this.sessionUserId || 'anon'}::${this.sessionTenantId || 'nocompany'}`;
  }

  /**
   * Begin or register an explicit action/batch.
   * Assigns a stable actionId and creates an active ActionBatchState.
   */
  beginAction(options?: BeginActionOptions): string {
    const actionId = options?.actionId || options?.batchId || ('act_' + mintDispatchId());
    const actionScope = options?.actionScope || 'default';
    const tenantId = options?.tenantId ?? this.sessionTenantId;
    const userId = options?.userId ?? this.sessionUserId;

    const existing = this.actions.get(actionId);
    if (existing && existing.status === 'active') {
      return actionId;
    }

    const batch: ActionBatchState = {
      actionId,
      actionScope,
      tenantId,
      userId,
      createdAt: Date.now(),
      status: 'active',
      units: new Map<string, ActionUnitState>(),
    };
    this.actions.set(actionId, batch);
    return actionId;
  }

  /**
   * Prepare a unit under an action.
   * Mints or preserves stable dispatchId, handles re-entry and material change checks.
   */
  prepareUnit(
    actionId: string,
    unitId: string,
    record: Record<string, unknown>,
    options?: { actionScope?: string; tenantId?: string; userId?: string }
  ): { dispatchId: string; unitId: string; actionId: string } {
    // Validate payload (e.g. decline fields) before binding or retaining unit state
    jsonSafe(record);

    let action = this.actions.get(actionId);
    if (!action || action.status !== 'active') {
      this.beginAction({
        actionId,
        actionScope: options?.actionScope || 'default',
        tenantId: options?.tenantId ?? this.sessionTenantId,
        userId: options?.userId ?? this.sessionUserId,
      });
      action = this.actions.get(actionId)!;
    }

    // Verify tenant and user scope isolation
    const reqTenant = (typeof record.companyId === 'string' ? record.companyId : options?.tenantId) ?? this.sessionTenantId;
    if (action.tenantId && reqTenant && action.tenantId !== reqTenant) {
      throw new Error(`tenant_isolation_violation: action tenant ${action.tenantId} != request tenant ${reqTenant}`);
    }
    const reqUser = (typeof record.assignedByUid === 'string' ? record.assignedByUid : options?.userId) ?? this.sessionUserId;
    if (action.userId && reqUser && action.userId !== reqUser) {
      throw new Error(`user_isolation_violation: action user ${action.userId} != request user ${reqUser}`);
    }

    let unit = action.units.get(unitId);

    const explicitId = typeof record.id === 'string' && record.id.trim()
      ? record.id.trim()
      : (typeof record.dispatchId === 'string' && record.dispatchId.trim()
        ? record.dispatchId.trim()
        : '');

    if (unit) {
      // If unit already succeeded, preserve identity
      if (unit.status === 'succeeded') {
        return { dispatchId: unit.dispatchId, unitId, actionId };
      }
      // If material birth fields match, preserve existing dispatchId across rerender/re-entry
      if (materialBirthFieldsMatch(unit.payloadRecord, record)) {
        // Presentation field update (Requirement 7): update payload without changing dispatchId
        unit.payloadRecord = { ...unit.payloadRecord, ...record, dispatchId: unit.dispatchId };
        unit.updatedAt = Date.now();
        return { dispatchId: unit.dispatchId, unitId, actionId };
      }
      // Materially different immutable birth (Requirement 6):
      // If birth fields changed materially, it's a new deliberate action for this slot.
      const newDispatchId = explicitId || mintDispatchId();
      unit.dispatchId = newDispatchId;
      unit.payloadRecord = { ...record, dispatchId: newDispatchId };
      unit.status = 'pending';
      unit.updatedAt = Date.now();
      return { dispatchId: newDispatchId, unitId, actionId };
    }

    // New unit for this action
    const dispatchId = explicitId || mintDispatchId();
    unit = {
      actionId,
      unitId,
      dispatchId,
      payloadRecord: { ...record, dispatchId },
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentRequestId: 0,
    };
    action.units.set(unitId, unit);
    this.unitKeyIndex.set(`${actionId}::${unitId}`, { actionId, unitId });
    return { dispatchId, unitId, actionId };
  }

  /**
   * Execute dispatch creation for an action unit.
   *
   * Guarantees:
   * 1. In-flight protection (Req 1): joins existing in-flight promise.
   * 2. Retry protection (Req 2, 3, 4, 7, 20, 21): reuses exact dispatchId on retry.
   * 3. Succeeded retention (Req 5, 20): succeeded units in batch are NOT recreated under new IDs;
   *    they return retained success (or safe replay).
   * 4. Stale-completion guard (Req F3, 26-30): stale completion generation cannot overwrite or clear newer identity.
   */
  async executeUnit(
    invoke: CallableInvoker,
    record: Record<string, unknown>,
    options?: ExecuteUnitOptions
  ): Promise<{ dispatchId: string }> {
    if (this.sessionTenantId && record.companyId && record.companyId !== this.sessionTenantId) {
      throw new Error(`tenant_isolation_violation: coordinator tenant ${this.sessionTenantId} != payload companyId ${record.companyId}`);
    }

    const isExplicitAction = Boolean(options?.actionId || options?.actionScope);
    const actionScope = options?.actionScope || 'default';
    const unitKey = computeCreationUnitKey(record, options?.unitKey);
    const unitId = options?.unitId || unitKey;
    const actionId = options?.actionId || (options?.actionScope ? `act_${options.actionScope}` : `act_${unitKey}`);

    const { dispatchId } = this.prepareUnit(actionId, unitId, record, {
      actionScope,
      tenantId: options?.tenantId,
      userId: options?.userId,
    });

    const action = this.actions.get(actionId)!;
    const unit = action.units.get(unitId)!;

    // Check if already succeeded (Requirement 20: partial batch retry)
    if (unit.status === 'succeeded' && !options?.forceReplay) {
      return unit.result || { dispatchId: unit.dispatchId };
    }

    // In-flight guard (Requirement 1: double-click joins active promise)
    if (unit.status === 'in_flight' && unit.inFlightPromise) {
      return unit.inFlightPromise;
    }

    // Generation token for stale guard (Requirement F3, 26-30)
    unit.currentRequestId++;
    const thisRequestId = unit.currentRequestId;
    unit.status = 'in_flight';

    // Merge stable dispatchId into payload and caller record
    const finalRecord: Record<string, unknown> = {
      ...unit.payloadRecord,
      ...record,
      dispatchId: unit.dispatchId,
    };
    unit.payloadRecord = finalRecord;
    record.dispatchId = unit.dispatchId;

    const payload = buildCreatePayload(finalRecord);

    const promise = (async () => {
      try {
        const res = await invoke(payload);

        // Stale guard: verify this resolution still matches the active request generation
        if (unit.currentRequestId === thisRequestId) {
          unit.status = 'succeeded';
          unit.result = (res.data as { dispatchId: string }) || { dispatchId: unit.dispatchId };
          unit.inFlightPromise = undefined;
          unit.updatedAt = Date.now();
          if (!isExplicitAction) {
            this.finalizeAction(actionId);
          }
        }
        return (res.data as { dispatchId: string }) || { dispatchId: unit.dispatchId };
      } catch (err: any) {
        // Stale guard: verify error matches current generation
        if (unit.currentRequestId === thisRequestId) {
          const isKnown = err && (err.code === 'permission-denied' || err.code === 'invalid-argument' || err.message?.includes('validation') || err.message?.includes('immutable'));
          unit.status = isKnown ? 'failed-known' : 'failed-uncertain';
          unit.lastError = err;
          unit.inFlightPromise = undefined;
          unit.updatedAt = Date.now();
        }
        throw err;
      }
    })();

    unit.inFlightPromise = promise;
    return promise;
  }

  /**
   * Finalize an action/batch after all units succeed.
   * Prunes the completed action and its units from memory (Requirement 22, F4).
   */
  finalizeAction(actionId: string): void {
    const action = this.actions.get(actionId);
    if (!action) return;
    action.status = 'finalized';
    action.finalizedAt = Date.now();
    for (const unitId of action.units.keys()) {
      this.unitKeyIndex.delete(`${actionId}::${unitId}`);
    }
    this.actions.delete(actionId);
  }

  /**
   * Cancel an explicit action/batch.
   * ONLY clears this specific action and its units. Never clears unrelated actions (Requirement F1, 8-15).
   */
  cancelAction(actionId: string): void {
    const action = this.actions.get(actionId);
    if (!action) return;
    action.status = 'canceled';
    for (const unit of action.units.values()) {
      unit.status = 'canceled';
      unit.inFlightPromise = undefined;
      this.unitKeyIndex.delete(`${actionId}::${unit.unitId}`);
    }
    this.actions.delete(actionId);
  }

  /**
   * Cancel an action by actionId or actionScope.
   * Preserves all other actions.
   */
  cancelCreation(scopeOrActionId: string): void {
    if (this.actions.has(scopeOrActionId)) {
      this.cancelAction(scopeOrActionId);
      return;
    }
    const matching = [];
    for (const [actionId, action] of this.actions.entries()) {
      if (action.actionScope === scopeOrActionId || actionId === `act_${scopeOrActionId}`) {
        matching.push(actionId);
      }
    }
    for (const aid of matching) {
      this.cancelAction(aid);
    }
  }

  /**
   * Retry all non-succeeded units under an action.
   */
  async retryAction(actionId: string, invoke: CallableInvoker): Promise<Array<{ dispatchId: string }>> {
    const action = this.actions.get(actionId);
    if (!action) throw new Error(`action_not_found:${actionId}`);
    const results: Array<{ dispatchId: string }> = [];
    for (const unit of action.units.values()) {
      const res = await this.executeUnit(invoke, unit.payloadRecord, {
        actionId,
        unitId: unit.unitId,
        actionScope: action.actionScope,
      });
      results.push(res);
    }
    return results;
  }

  // --- Backwards Compatibility / Single-Unit Convenience Methods ---

  prepareCreation(
    record: Record<string, unknown>,
    options?: { unitKey?: string; actionId?: string; actionScope?: string }
  ): { dispatchId: string; unitKey: string } {
    const unitKey = computeCreationUnitKey(record, options?.unitKey);
    const actionId = options?.actionId || (options?.actionScope ? `act_${options.actionScope}` : `act_${unitKey}`);
    const unitId = unitKey;
    const res = this.prepareUnit(actionId, unitId, record, {
      actionScope: options?.actionScope,
    });
    return { dispatchId: res.dispatchId, unitKey };
  }

  async executeCreate(
    invoke: CallableInvoker,
    record: Record<string, unknown>,
    options?: ExecuteUnitOptions
  ): Promise<{ dispatchId: string }> {
    return this.executeUnit(invoke, record, options);
  }

  clear(unitKeyOrActionId?: string): void {
    if (!unitKeyOrActionId) {
      this.actions.clear();
      this.unitKeyIndex.clear();
      return;
    }
    if (this.actions.has(unitKeyOrActionId)) {
      this.cancelAction(unitKeyOrActionId);
      return;
    }
    this.cancelCreation(unitKeyOrActionId);
    for (const [actionId, action] of this.actions.entries()) {
      if (action.units.has(unitKeyOrActionId)) {
        action.units.delete(unitKeyOrActionId);
        this.unitKeyIndex.delete(`${actionId}::${unitKeyOrActionId}`);
        if (action.units.size === 0) {
          this.actions.delete(actionId);
        }
      }
    }
  }

  clearAll(): void {
    this.actions.clear();
    this.unitKeyIndex.clear();
  }

  cancelAll(): void {
    this.actions.clear();
    this.unitKeyIndex.clear();
  }

  isInFlight(unitKeyOrActionId?: string): boolean {
    if (unitKeyOrActionId) {
      const action = this.actions.get(unitKeyOrActionId);
      if (action) {
        for (const u of action.units.values()) {
          if (u.status === 'in_flight') return true;
        }
      }
      for (const act of this.actions.values()) {
        const u = act.units.get(unitKeyOrActionId);
        if (u && u.status === 'in_flight') return true;
      }
      return false;
    }
    for (const act of this.actions.values()) {
      for (const u of act.units.values()) {
        if (u.status === 'in_flight') return true;
      }
    }
    return false;
  }

  getAction(actionId: string): ActionBatchState | undefined {
    return this.actions.get(actionId);
  }

  getUnit(actionId: string, unitId: string): ActionUnitState | undefined {
    return this.actions.get(actionId)?.units.get(unitId);
  }

  getRetainedRequest(unitKey: string): RetainedCreationRequest | undefined {
    for (const action of this.actions.values()) {
      const unit = action.units.get(unitKey);
      if (unit) {
        const statusMap: Record<UnitStatus, 'idle' | 'in_flight' | 'uncertain_error' | 'succeeded'> = {
          pending: 'idle',
          in_flight: 'in_flight',
          'failed-known': 'uncertain_error',
          'failed-uncertain': 'uncertain_error',
          succeeded: 'succeeded',
          canceled: 'idle',
        };
        return {
          dispatchId: unit.dispatchId,
          unitKey,
          payloadRecord: unit.payloadRecord,
          createdAt: unit.createdAt,
          status: statusMap[unit.status] || 'idle',
          inFlightPromise: unit.inFlightPromise,
          lastError: unit.lastError,
          actionId: unit.actionId,
          unitId: unit.unitId,
        };
      }
    }
    return undefined;
  }

  getAllRetained(): RetainedCreationRequest[] {
    const list: RetainedCreationRequest[] = [];
    for (const action of this.actions.values()) {
      for (const [unitKey, unit] of action.units.entries()) {
        const statusMap: Record<UnitStatus, 'idle' | 'in_flight' | 'uncertain_error' | 'succeeded'> = {
          pending: 'idle',
          in_flight: 'in_flight',
          'failed-known': 'uncertain_error',
          'failed-uncertain': 'uncertain_error',
          succeeded: 'succeeded',
          canceled: 'idle',
        };
        list.push({
          dispatchId: unit.dispatchId,
          unitKey,
          payloadRecord: unit.payloadRecord,
          createdAt: unit.createdAt,
          status: statusMap[unit.status] || 'idle',
          inFlightPromise: unit.inFlightPromise,
          lastError: unit.lastError,
          actionId: unit.actionId,
          unitId: unit.unitId,
        });
      }
    }
    return list;
  }
}

let defaultCoordinator: DispatchCreationCoordinator | null = null;
export function getGlobalCreationCoordinator(options?: CoordinatorOptions): DispatchCreationCoordinator {
  if (!defaultCoordinator) {
    defaultCoordinator = new DispatchCreationCoordinator(options);
  } else if (options?.tenantId && defaultCoordinator.sessionTenantId !== options.tenantId) {
    defaultCoordinator.resetAuthenticatedSession(options.tenantId, options.userId);
  }
  return defaultCoordinator;
}
export function resetGlobalCreationCoordinator(options?: CoordinatorOptions): void {
  defaultCoordinator = new DispatchCreationCoordinator(options);
}

/**
 * Build payload for staffCreateDispatch.
 *
 * Preserves explicit or pre-minted dispatchId. If none provided, mints one via mintDispatchId().
 */
export function buildCreatePayload(record: Record<string, unknown>): Record<string, unknown> {
  const safe = jsonSafe(record);
  let dispatchId = typeof safe.id === 'string' && safe.id.trim()
    ? safe.id.trim()
    : (typeof safe.dispatchId === 'string' && safe.dispatchId.trim()
      ? safe.dispatchId.trim()
      : '');
  if (!dispatchId) {
    dispatchId = mintDispatchId();
    record.dispatchId = dispatchId;
  }

  const packageId = typeof safe.packageId === 'string' && safe.packageId.trim()
    ? safe.packageId.trim()
    : 'water-hauling';
  const revision = typeof safe.packetRevision === 'number' && Number.isInteger(safe.packetRevision) && safe.packetRevision > 0
    ? safe.packetRevision
    : 1;

  delete safe.id;
  delete safe.dispatchId;
  delete safe.packageId;
  delete safe.packetRevision;
  // The callable chooses the initial status; client status is an authority field.
  delete safe.status;

  return {
    op: 'create',
    dispatchId,
    packetRef: { packageId, revision },
    record: safe,
  };
}

export function buildUpdatePayload(dispatchId: string, record: Record<string, unknown>): Record<string, unknown> {
  return { op: 'update', dispatchId, record: jsonSafe(record) };
}
export function buildCancelPayload(dispatchId: string): Record<string, unknown> {
  return { op: 'cancel', dispatchId };
}

export async function runCreateDispatch(
  invoke: CallableInvoker,
  record: Record<string, unknown>,
  coordinator?: DispatchCreationCoordinator,
  options?: ExecuteUnitOptions
): Promise<{ dispatchId: string }> {
  const coord = coordinator || getGlobalCreationCoordinator();
  return coord.executeUnit(invoke, record, options);
}

export async function runUpdateDispatch(invoke: CallableInvoker, dispatchId: string, record: Record<string, unknown>): Promise<void> {
  await invoke(buildUpdatePayload(dispatchId, record));
}
export async function runCancelDispatch(invoke: CallableInvoker, dispatchId: string): Promise<void> {
  await invoke(buildCancelPayload(dispatchId));
}