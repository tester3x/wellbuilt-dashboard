/**
 * Route Me assignment state resolver.
 *
 * Evaluates well assignment against active dispatches in Firestore:
 * - 'unassigned': No active dispatch -> selectable
 * - 'assigned_self': Active dispatch for the calling driver -> already loaded
 * - 'assigned_other': Active dispatch for another driver -> muted, visible, not selectable
 * - 'in_ddjd': Already in calling driver's DDJD
 */

export type RouteMeAssignmentState =
  | 'unassigned'
  | 'assigned_self'
  | 'assigned_other'
  | 'in_ddjd';

export interface DispatchLike {
  id?: string;
  companyId?: string;
  wellName?: string;
  wellId?: string;
  driverId?: string;
  driverName?: string;
  driverFirstName?: string;
  status?: string;
  in_ddjd?: boolean;
}

export interface WellAssignmentResult {
  assignmentState: RouteMeAssignmentState;
  assignee?: string;
  muted: boolean;
}

export const ACTIVE_DISPATCH_STATUSES = new Set([
  'pending',
  'pending_approval',
  'accepted',
  'in_progress',
  'paused',
]);

/**
 * Resolve assignment state for a well against active dispatches.
 */
export function resolveWellAssignment(
  well: { wellName: string; wellId?: string; companyId: string },
  activeDispatches: DispatchLike[],
  callingDriverId: string,
): WellAssignmentResult {
  const normWellName = (well.wellName || '').toLowerCase().trim();
  const canonicalWellId = (well.wellId || '').trim();

  // Find matching active dispatch for this well within the same company
  const match = activeDispatches.find((d) => {
    if (!d.status || !ACTIVE_DISPATCH_STATUSES.has(d.status.toLowerCase())) {
      return false;
    }
    if (d.companyId && d.companyId.trim() !== well.companyId) {
      return false;
    }

    if (canonicalWellId && d.wellId && d.wellId.trim() === canonicalWellId) {
      return true;
    }

    const dWellName = (d.wellName || '').toLowerCase().trim();
    return dWellName && dWellName === normWellName;
  });

  if (!match) {
    return {
      assignmentState: 'unassigned',
      muted: false,
    };
  }

  const isSelf = match.driverId === callingDriverId;
  const driverDisplayName = match.driverFirstName || match.driverName || (isSelf ? 'You' : 'another driver');

  if (isSelf) {
    const isDdjd = Boolean(match.in_ddjd);
    return {
      assignmentState: isDdjd ? 'in_ddjd' : 'assigned_self',
      assignee: driverDisplayName,
      muted: false,
    };
  }

  return {
    assignmentState: 'assigned_other',
    assignee: driverDisplayName,
    muted: true,
  };
}
