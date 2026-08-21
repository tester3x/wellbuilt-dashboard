/**
 * Dashboard client helpers for secure driver identity callables.
 * Prefer these over direct RTDB writes for approve/reject/passcode.
 */
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export async function adminListPending() {
  const fn = httpsCallable(getFirebaseFunctions(), 'adminListPendingRegistrations');
  const res = await fn({});
  return res.data as {
    pending: any[];
    legacyPending: any[];
  };
}

export async function adminApproveSecure(params: {
  pendingId: string;
  companyId?: string;
  companyName?: string;
  assignedCustomers?: { name: string; companyId: string }[];
  assignedRoutes?: string[];
  roles?: string[];
}) {
  const fn = httpsCallable(getFirebaseFunctions(), 'adminApproveDriverRegistration');
  const res = await fn(params);
  return res.data;
}

export async function adminRejectSecure(params: {
  pendingId?: string;
  legacyKey?: string;
}) {
  const fn = httpsCallable(getFirebaseFunctions(), 'adminRejectDriverRegistration');
  const res = await fn(params);
  return res.data;
}

export async function staffWriteDriverAssignment(params: {
  driverId: string;
  assignedRoutes: string[];
  assignedWells: string[];
  mode: 'dry-run' | 'apply';
  expectedAssignmentDigest?: string;
  expectedProposedDigest?: string;
}) {
  const fn = httpsCallable(getFirebaseFunctions(), 'staffWriteDriverAssignment');
  const res = await fn(params);
  return res.data as {
    ok: true;
    mode: 'dry-run' | 'apply';
    driverId: string;
    companyId: string;
    before: { assignedRoutes: unknown; assignedWells: unknown; assignmentRevision?: unknown };
    after: { assignedRoutes: string[]; assignedWells: string[] };
    currentDigest: string;
    proposedDigest: string;
    changedFields: string[];
    assignmentRevision?: unknown;
  };
}

export async function adminSetPasscode(params: {
  displayName: string;
  passcode: string;
  driverId?: string;
  legacyHash?: string;
  approvedKey?: string;
  companyId?: string;
  companyName?: string;
  legalName?: string;
  /** Default true on server — force first-login change */
  temporary?: boolean;
  keepLegacyActive?: boolean;
}) {
  const fn = httpsCallable(getFirebaseFunctions(), 'adminSetDriverPasscode');
  const res = await fn(params);
  return res.data as {
    driverId: string;
    displayName: string;
    mustChangePasscode?: boolean;
  };
}

/**
 * Governed INITIAL company binding for a canonical secure driver. The
 * server validates preconditions, ensures the shift authority under the
 * same canonical UUID, and reports success only when profile and authority
 * agree. Exact-key payload: anything beyond driverId/companyId is refused.
 */
export async function adminBindCompany(params: {
  driverId: string;
  companyId: string;
}) {
  const fn = httpsCallable(getFirebaseFunctions(), 'adminBindDriverCompany');
  const res = await fn(params);
  return res.data as {
    ok: true;
    companyId: string;
    companyName: string | null;
    alreadyBound: boolean;
    authority: 'created' | 'initialized' | 'preserved';
  };
}

export async function adminDeleteSecureDriver(params: {
  driverId: string;
  confirm?: string;
}) {
  const fn = httpsCallable(getFirebaseFunctions(), 'adminDeleteSecureDriver');
  const res = await fn({
    driverId: params.driverId,
    confirm: params.confirm || 'DELETE_SECURE_DRIVER',
  });
  return res.data;
}
