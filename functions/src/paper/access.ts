import type { PaperArtifactRecord, PaperCaller } from './types';

/** Mirrors Dashboard src/lib/auth.ts defaults for Tickets/Dispatch surfaces. */
const DEFAULT_READ_ROLES = new Set(['it', 'admin', 'manager', 'dispatch', 'viewer']);
const DEFAULT_MATERIALIZE_ROLES = new Set(['it', 'admin', 'manager']);

function hasCap(caller: PaperCaller, cap: string): boolean {
  return Array.isArray(caller.caps) && caller.caps.includes(cap);
}

function hasRole(caller: PaperCaller, roles: Set<string>): boolean {
  return (caller.roles || []).some((r) => roles.has(r));
}

export function dashboardCanReadPaper(caller: PaperCaller): boolean {
  if (caller.kind !== 'dashboard') return false;
  if (caller.isPlatformAdmin) return true;
  if (hasCap(caller, 'viewTickets') || hasCap(caller, 'viewDispatch')) return true;
  return hasRole(caller, DEFAULT_READ_ROLES);
}

export function dashboardCanMaterializePaper(caller: PaperCaller): boolean {
  if (caller.kind !== 'dashboard') return false;
  if (caller.isPlatformAdmin) return true;
  if (hasCap(caller, 'manageDrivers')) return true;
  return hasRole(caller, DEFAULT_MATERIALIZE_ROLES);
}

export function authorizePaperCompany(
  caller: PaperCaller,
  companyId: string,
): { ok: true } | { ok: false; reason: string; message: string } {
  if (!companyId) {
    return { ok: false, reason: 'company_required', message: 'Artifact has no companyId.' };
  }
  if (caller.isPlatformAdmin && caller.kind === 'dashboard') return { ok: true };
  if (!caller.companyId) {
    return { ok: false, reason: 'caller_unscoped', message: 'Caller has no company scope.' };
  }
  if (caller.companyId !== companyId) {
    return { ok: false, reason: 'wrong_company', message: 'Cannot resolve another company\'s artifact.' };
  }
  return { ok: true };
}

export function authorizePaperRead(
  caller: PaperCaller,
  artifact: Pick<PaperArtifactRecord, 'companyId' | 'ownerDriverId'>,
): { ok: true } | { ok: false; reason: string; message: string } {
  const company = authorizePaperCompany(caller, artifact.companyId);
  if (!company.ok) return company;
  if (caller.kind === 'dashboard') {
    if (!dashboardCanReadPaper(caller)) {
      return { ok: false, reason: 'missing_capability', message: 'Caller cannot view Tickets or Dispatch paper.' };
    }
    return { ok: true };
  }
  if (caller.kind === 'driver') {
    if (!caller.driverId || !artifact.ownerDriverId || caller.driverId !== artifact.ownerDriverId) {
      return { ok: false, reason: 'not_document_owner', message: 'Driver may only read their own paper.' };
    }
    return { ok: true };
  }
  return { ok: false, reason: 'unauthorized', message: 'Caller is not authorized to read paper.' };
}

export function authorizePaperMaterialize(
  caller: PaperCaller,
  companyId: string,
): { ok: true } | { ok: false; reason: string; message: string } {
  if (caller.kind === 'driver') {
    return { ok: false, reason: 'drivers_cannot_materialize', message: 'Drivers cannot materialize paper.' };
  }
  const company = authorizePaperCompany(caller, companyId);
  if (!company.ok) return company;
  if (!dashboardCanMaterializePaper(caller)) {
    return { ok: false, reason: 'missing_capability', message: 'Caller cannot materialize paper.' };
  }
  return { ok: true };
}
