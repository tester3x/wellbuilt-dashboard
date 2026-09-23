/**
 * Firebase-free CORE for governed Dashboard dispatch writes.
 *
 * Holds the payload serialization (jsonSafe), the exact callable name, the
 * op-specific payload builders, and the runners that push a payload through an
 * injected invoker. The thin staffWriteDispatch.ts wrapper supplies the real
 * httpsCallable; tests supply a mock invoker and assert the wire contract by
 * actually executing this code.
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

export interface RetainedCreationRequest {
  dispatchId: string;
  unitKey: string;
  payloadRecord: Record<string, unknown>;
  createdAt: number;
  status: 'idle' | 'in_flight' | 'uncertain_error' | 'succeeded';
  inFlightPromise?: Promise<{ dispatchId: string }>;
  lastError?: unknown;
}

/**
 * Coordinates creation actions, ensuring exactly one stable dispatchId is minted
 * at the deliberate creation-action boundary, preserved across rerender, double-click,
 * and retry after uncertain transport failure, and cleared upon definitive success or cancellation.
 */
export class DispatchCreationCoordinator {
  private retained = new Map<string, RetainedCreationRequest>();

  /**
   * Pre-mint or retrieve a stable dispatchId for a creation action unit.
   * If caller already supplied an explicit dispatchId on record, that ID is bound and preserved.
   */
  prepareCreation(
    record: Record<string, unknown>,
    options?: { unitKey?: string }
  ): { dispatchId: string; unitKey: string } {
    const unitKey = computeCreationUnitKey(record, options?.unitKey);
    const existing = this.retained.get(unitKey);

    const explicitId = typeof record.id === 'string' && record.id.trim()
      ? record.id.trim()
      : (typeof record.dispatchId === 'string' && record.dispatchId.trim()
        ? record.dispatchId.trim()
        : '');

    if (existing && existing.status !== 'succeeded') {
      // Check if material birth fields match the active deliberate creation action
      if (materialBirthFieldsMatch(existing.payloadRecord, record)) {
        return { dispatchId: existing.dispatchId, unitKey };
      }
      // Material change constitutes a new deliberate action: invalidate previous retained request
      this.retained.delete(unitKey);
    }

    const dispatchId = explicitId || mintDispatchId();
    const req: RetainedCreationRequest = {
      dispatchId,
      unitKey,
      payloadRecord: { ...record, dispatchId },
      createdAt: Date.now(),
      status: 'idle',
    };
    this.retained.set(unitKey, req);
    return { dispatchId, unitKey };
  }

  /**
   * Execute or retry dispatch creation for this action unit.
   *
   * In-flight protection (Requirement 6):
   * If this unit is currently in-flight, returns the active promise (prevents double-click duplicate calls).
   *
   * Retry protection (Requirements 2, 3, 7):
   * If previous attempt failed with uncertain error, reuses the exact same dispatchId and payload.
   *
   * Success clearance (Requirement 8):
   * Upon definitive success, clears the retained request so subsequent actions receive a fresh ID.
   */
  async executeCreate(
    invoke: CallableInvoker,
    record: Record<string, unknown>,
    options?: { unitKey?: string }
  ): Promise<{ dispatchId: string }> {
    const { dispatchId, unitKey } = this.prepareCreation(record, options);
    const req = this.retained.get(unitKey)!;

    // In-flight guard: if request is already executing, join existing promise
    if (req.status === 'in_flight' && req.inFlightPromise) {
      return req.inFlightPromise;
    }

    // Merge stable dispatchId into payload without relying on caller mutating temporary object
    const finalRecord: Record<string, unknown> = {
      ...req.payloadRecord,
      ...record,
      dispatchId,
    };
    req.payloadRecord = finalRecord;
    // Also write back to caller record for compatibility
    record.dispatchId = dispatchId;

    const payload = buildCreatePayload(finalRecord);
    req.status = 'in_flight';

    const promise = (async () => {
      try {
        const res = await invoke(payload);
        req.status = 'succeeded';
        // Definitively successful: clear retained request
        this.retained.delete(unitKey);
        return res.data as { dispatchId: string };
      } catch (err) {
        req.status = 'uncertain_error';
        req.lastError = err;
        req.inFlightPromise = undefined;
        throw err;
      }
    })();

    req.inFlightPromise = promise;
    return promise;
  }

  clear(unitKey?: string): void {
    if (unitKey) {
      this.retained.delete(unitKey);
    } else {
      this.retained.clear();
    }
  }

  clearAll(): void {
    this.retained.clear();
  }

  cancelAll(): void {
    this.retained.clear();
  }

  isInFlight(unitKey?: string): boolean {
    if (unitKey) {
      return this.retained.get(unitKey)?.status === 'in_flight';
    }
    for (const req of this.retained.values()) {
      if (req.status === 'in_flight') return true;
    }
    return false;
  }

  getRetainedRequest(unitKey: string): RetainedCreationRequest | undefined {
    return this.retained.get(unitKey);
  }

  getAllRetained(): RetainedCreationRequest[] {
    return Array.from(this.retained.values());
  }
}

let globalCoordinator: DispatchCreationCoordinator | null = null;
export function getGlobalCreationCoordinator(): DispatchCreationCoordinator {
  if (!globalCoordinator) {
    globalCoordinator = new DispatchCreationCoordinator();
  }
  return globalCoordinator;
}
export function resetGlobalCreationCoordinator(): void {
  globalCoordinator = new DispatchCreationCoordinator();
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
    // Attach back to caller's in-memory record so immediate retries reuse this exact ID.
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
  options?: { unitKey?: string }
): Promise<{ dispatchId: string }> {
  const coord = coordinator || getGlobalCreationCoordinator();
  return coord.executeCreate(invoke, record, options);
}

export async function runUpdateDispatch(invoke: CallableInvoker, dispatchId: string, record: Record<string, unknown>): Promise<void> {
  await invoke(buildUpdatePayload(dispatchId, record));
}
export async function runCancelDispatch(invoke: CallableInvoker, dispatchId: string): Promise<void> {
  await invoke(buildCancelPayload(dispatchId));
}
