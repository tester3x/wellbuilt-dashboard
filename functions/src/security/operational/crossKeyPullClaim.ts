/**
 * One physical pull may arrive as packets/incoming/{id} and
 * packets/incoming/idem_{id}. The claim is the single identity.
 * The second matching arrival is retired. A different payload or
 * company is not applied and is not overwritten onto the winner.
 */

export interface PullClaim {
  logicalId: string;
  winnerKey: string;
  companyId: string | null;
  driverId: string | null;
  wellKey: string;
  bblsTaken: number | null;
  tankLevelFeet: number | null;
  phase: 'claimed' | 'applied';
}

export interface PullIdentity {
  storageKey: string;
  companyId?: string | null;
  driverId?: string | null;
  wellName?: string | null;
  bblsTaken?: unknown;
  tankLevelFeet?: unknown;
}

export type CrossKeyOutcome = 'proceed' | 'retire' | 'conflict' | 'cross_tenant';

export function logicalPullId(storageKey: string): string {
  const id = String(storageKey || '').trim();
  return id.startsWith('idem_') ? id.slice('idem_'.length) : id;
}

export function counterpartStorageKey(storageKey: string): string {
  const id = String(storageKey || '').trim();
  return id.startsWith('idem_') ? logicalPullId(id) : `idem_${id}`;
}

export function shouldApplyCrossKeyGuard(requestType: unknown): boolean {
  return (typeof requestType === 'string' && requestType ? requestType : 'pull') === 'pull';
}

function wellKey(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function sameNumber(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 1e-6;
}

export function buildPullClaim(identity: PullIdentity): PullClaim {
  return {
    logicalId: logicalPullId(identity.storageKey),
    winnerKey: identity.storageKey,
    companyId: identity.companyId ? String(identity.companyId) : null,
    driverId: identity.driverId ? String(identity.driverId) : null,
    wellKey: wellKey(identity.wellName),
    bblsTaken: num(identity.bblsTaken),
    tankLevelFeet: num(identity.tankLevelFeet),
    phase: 'claimed',
  };
}

function tenantConflicts(claim: PullClaim, identity: PullIdentity): boolean {
  const company = identity.companyId ? String(identity.companyId) : '';
  const driver = identity.driverId ? String(identity.driverId) : '';
  if (claim.companyId && company && claim.companyId !== company) return true;
  if (claim.driverId && driver && claim.driverId !== driver) return true;
  return false;
}

function payloadConflicts(claim: PullClaim, identity: PullIdentity): boolean {
  if (claim.wellKey !== wellKey(identity.wellName)) return true;
  if (!sameNumber(claim.bblsTaken, num(identity.bblsTaken))) return true;
  if (!sameNumber(claim.tankLevelFeet, num(identity.tankLevelFeet))) return true;
  return false;
}

/**
 * Decide the transaction write. Returning the existing claim does not
 * replace the winner. Date/time is intentionally not a conflict: the
 * ticket submit relay stamps a later clock on the same physical pull.
 */
export function crossKeyClaimUpdate(
  current: PullClaim | null,
  identity: PullIdentity,
): { next: PullClaim; outcome: CrossKeyOutcome } {
  const incoming = buildPullClaim(identity);
  if (!current) return { next: incoming, outcome: 'proceed' };
  if (current.winnerKey === identity.storageKey) return { next: current, outcome: 'proceed' };
  if (tenantConflicts(current, identity)) return { next: current, outcome: 'cross_tenant' };
  if (payloadConflicts(current, identity)) return { next: current, outcome: 'conflict' };
  return { next: current, outcome: 'retire' };
}

export function markPullClaimApplied(current: PullClaim | null, storageKey: string): PullClaim | null {
  if (!current || current.winnerKey !== storageKey) return current;
  if (current.phase === 'applied') return current;
  return { ...current, phase: 'applied' };
}

export interface ClaimRef {
  transaction(update: (current: PullClaim | null) => PullClaim): Promise<{ snapshot: { val(): PullClaim | null } }>;
}

export async function commitPullClaim(ref: ClaimRef, identity: PullIdentity): Promise<CrossKeyOutcome> {
  const result = await ref.transaction((current) => crossKeyClaimUpdate(current, identity).next);
  const committed = result.snapshot.val();
  if (!committed) return 'proceed';
  return crossKeyClaimUpdate(committed, identity).outcome === 'proceed'
    && committed.winnerKey === identity.storageKey
    ? 'proceed'
    : crossKeyClaimUpdate(committed, identity).outcome;
}
