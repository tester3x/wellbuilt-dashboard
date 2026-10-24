import { evaluateWbmWellScope, wellBelongsToDriverCompany, wellMatchesWbmScope } from './wbmWellScope';
export type Row = Record<string, any>;
export const TANK_INFO_FIELDS = ['totalTanks', 'activeTanks', 'tankHeight', 'tankDiameter',
  'tankCapacity', 'perTankBblPerFoot', 'h2sStatus', 'loadLine', 'allowedBottom', 'tankNotes'] as const;
export const TANK_INFO_DISPLAY_FIELDS = [...TANK_INFO_FIELDS, 'numTanks', 'tanks', 'bblPerFoot',
  'route', 'operator', 'ndicName', 'ndicApiNo', 'tankInfoRevision', 'tankInfoUpdatedAt', 'tankInfoUpdatedBy', 'tankManufacturer', 'tankSerialNumber'] as const;
export function tankInfoAuthority(profile: Row, well: Row, driverId: string, companyId: string) {
  const admin = profile.isAdmin === true || profile.role === 'admin' || (Array.isArray(profile.roles) && profile.roles.includes('admin'));
  const scope = evaluateWbmWellScope(profile.assignedRoutes, profile.assignedWells);
  const canView = wellBelongsToDriverCompany(well, companyId)
    && (admin || profile.primaryAllRoutes === true || (scope.ok && wellMatchesWbmScope(well.wellName || '', well, scope)));
  const primary = profile.primaryAllRoutes === true || (typeof well.route === 'string' && Array.isArray(profile.primaryRoutes)
    && profile.primaryRoutes.includes(well.route) && Array.isArray(profile.assignedRoutes)
    && profile.assignedRoutes.includes(well.route));
  return { canView, canEdit: canView && profile.isViewer !== true && (admin || primary),
    canAssignPrimary: canView && profile.isViewer !== true && admin };
}
export function tankInfoProjection(well: Row): Row {
  return Object.fromEntries(TANK_INFO_DISPLAY_FIELDS.filter(k => well[k] !== undefined).map(k => [k, well[k]]));
}
export function tankInfoPatch(current: Row, raw: unknown): Row {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('invalid_patch');
  const patch = raw as Row;
  if (!Object.keys(patch).length || Object.keys(patch).some(k => !(TANK_INFO_FIELDS as readonly string[]).includes(k)))
    throw Error('invalid_field');
  const limits: Record<string, [number, number]> = {
    totalTanks: [1, 100], activeTanks: [1, 100], tankHeight: [1, 100], tankDiameter: [1, 100],
    tankCapacity: [1, 100000], perTankBblPerFoot: [0.1, 2000], loadLine: [0, 100], allowedBottom: [0, 100],
  };
  for (const [key, value] of Object.entries(patch)) {
    if (limits[key] && (typeof value !== 'number' || !Number.isFinite(value)
      || value < limits[key][0] || value > limits[key][1])) throw Error('invalid_' + key);
    if ((key === 'totalTanks' || key === 'activeTanks') && !Number.isInteger(value)) throw Error('invalid_' + key);
    if (key === 'h2sStatus' && !['unknown', 'none', 'low', 'high'].includes(value)) throw Error('invalid_h2sStatus');
    if (key === 'tankNotes' && (typeof value !== 'string' || value.length > 1000)) throw Error('invalid_tankNotes');
  }
  const result = { ...patch }, next = { ...current, ...patch };
  const count = Number(next.activeTanks ?? next.numTanks ?? next.tanks);
  const total = Number(next.totalTanks ?? current.numTanks ?? current.tanks);
  if (Number.isFinite(count) && Number.isFinite(total) && count > total) throw Error('active_exceeds_total');
  for (const key of ['loadLine', 'allowedBottom']) {
    if (Number(next[key]) > Number(next.tankHeight)) throw Error('level_exceeds_height');
  }
  if (patch.activeTanks !== undefined) Object.assign(result, { tanks: count, numTanks: count });
  if (patch.activeTanks !== undefined && current.totalTanks === undefined && Number.isFinite(total))
    result.totalTanks = total;
  if (patch.activeTanks !== undefined || patch.perTankBblPerFoot !== undefined || patch.tankDiameter !== undefined) {
    const oldCount = Number(current.activeTanks ?? current.numTanks ?? current.tanks);
    const perTank = patch.perTankBblPerFoot ?? (patch.tankDiameter !== undefined
      ? Math.round(Math.PI * (patch.tankDiameter / 2) ** 2 / 5.614583333333333 * 10) / 10
      : current.perTankBblPerFoot ?? Number(current.bblPerFoot) / oldCount);
    if (!Number.isFinite(perTank) || perTank <= 0 || !Number.isInteger(count) || count < 1)
      throw Error('calibration_required');
    Object.assign(result, { perTankBblPerFoot: perTank, bblPerFoot: Math.round(perTank * count * 10000) / 10000 });
  }
  return result;
}
