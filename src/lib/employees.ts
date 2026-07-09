// ── Unified Employee model (7/9 employee refactor, dev) ─────────────────────
// One PERSON can exist in two stores:
//   drivers/approved/{driverHash}  — WB-T mobile login (device registration)
//   users/{uid}                    — dashboard login (Firebase Auth)
// linked (when promoted via the inviteEmployee CF) by
//   drivers/approved/{hash}.dashboardUid  ↔  users/{uid}.driverHash
// This module merges the two lists into one row per person. Pure data — no
// Firebase reads/writes here; the Employees tab supplies the arrays it
// already loads and renders the result.
import { UserRole, getPrimaryRole } from './auth';

/** Structural subset of a drivers/approved record the merge needs. */
export interface EmployeeDriverInput {
  key: string;                 // driver hash
  displayName: string;
  legalName?: string;
  active?: boolean;
  companyId?: string;
  companyName?: string;
  dashboardUid?: string;
  dashboardRole?: UserRole;
}

/** Structural subset of a users/{uid} record the merge needs. */
export interface EmployeeUserInput {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  roles?: UserRole[];
  companyId?: string;
  companyName?: string;
  driverHash?: string;
}

export interface EmployeeRow<D extends EmployeeDriverInput = EmployeeDriverInput,
                             U extends EmployeeUserInput = EmployeeUserInput> {
  /** Stable row id: driver hash when a driver record exists, else `uid:` + uid. */
  id: string;
  name: string;                // legalName || displayName (driver side preferred)
  email?: string;              // dashboard side only
  companyId?: string;
  companyName?: string;
  /** WB-T mobile login: undefined = no driver record; else drivers.active !== false */
  mobileLoginActive?: boolean;
  /** Dashboard login exists (users/{uid} present) */
  hasDashboardLogin: boolean;
  /** Effective dashboard roles (users.roles ?? [users.role]); [] when no dashboard login */
  dashboardRoles: UserRole[];
  /** Primary role for display/legacy — derived, 'viewer' floor */
  primaryRole?: UserRole;
  driverHash?: string;
  dashboardUid?: string;
  /** Original records for the tab's existing modals/actions */
  driver?: D;
  dashUser?: U;
}

/**
 * Merge drivers + dashboard users into one row per person.
 * Link rule: driver.dashboardUid === user.uid OR user.driverHash === driver.key
 * (either side may be stamped — legacy records sometimes carry only one).
 * Unlinked records each get their own row.
 */
export function mergeEmployees<D extends EmployeeDriverInput, U extends EmployeeUserInput>(
  drivers: D[],
  users: U[],
): EmployeeRow<D, U>[] {
  const usersByUid = new Map(users.map(u => [u.uid, u]));
  const usersByDriverHash = new Map(
    users.filter(u => u.driverHash).map(u => [u.driverHash as string, u]),
  );
  const claimedUids = new Set<string>();

  const rows: EmployeeRow<D, U>[] = [];

  for (const d of drivers) {
    // Prefer the driver-side stamp, fall back to the user-side stamp.
    const linked =
      (d.dashboardUid ? usersByUid.get(d.dashboardUid) : undefined) ??
      usersByDriverHash.get(d.key);
    if (linked) claimedUids.add(linked.uid);
    const dashboardRoles = linked
      ? (linked.roles && linked.roles.length > 0 ? linked.roles : [linked.role])
      : [];
    rows.push({
      id: d.key,
      name: d.legalName || d.displayName,
      email: linked?.email,
      companyId: d.companyId || linked?.companyId,
      companyName: d.companyName || linked?.companyName,
      mobileLoginActive: d.active !== false,
      hasDashboardLogin: !!linked,
      dashboardRoles,
      primaryRole: linked ? getPrimaryRole(dashboardRoles) : undefined,
      driverHash: d.key,
      dashboardUid: linked?.uid ?? d.dashboardUid,
      driver: d,
      dashUser: linked,
    });
  }

  for (const u of users) {
    if (claimedUids.has(u.uid)) continue; // already merged into a driver row
    const dashboardRoles = u.roles && u.roles.length > 0 ? u.roles : [u.role];
    rows.push({
      id: `uid:${u.uid}`,
      name: u.displayName,
      email: u.email,
      companyId: u.companyId,
      companyName: u.companyName,
      mobileLoginActive: undefined, // no driver record → no mobile login
      hasDashboardLogin: true,
      dashboardRoles,
      primaryRole: getPrimaryRole(dashboardRoles),
      driverHash: u.driverHash, // may point at a not-yet-loaded/legacy driver
      dashboardUid: u.uid,
      dashUser: u,
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}
