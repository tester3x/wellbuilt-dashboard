export type ExceptionMode = 'independent' | 'dispatch_only' | 'hybrid';
export type ExceptionScope = { jobId: string; jobType: string; pickup: string; dropoff: string;
  pickupLat: number | null; pickupLng: number | null; dropoffLat: number | null; dropoffLng: number | null };
const name = (v: unknown) => typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').toLowerCase() : '';
export function exceptionMode(company: Record<string, unknown>): ExceptionMode {
  if (!Object.prototype.hasOwnProperty.call(company, 'liveDispatchSync')) return 'independent';
  if (company.liveDispatchSync === true) return 'hybrid';
  if (company.liveDispatchSync === false) return 'dispatch_only';
  throw Error('Company dispatch mode is unavailable');
}
export function parseExceptionScope(raw: any): ExceptionScope {
  if (!raw || typeof raw.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(raw.jobId)) throw Error('Invalid job');
  const jobType = name(raw.jobType), pickup = name(raw.pickup), dropoff = name(raw.dropoff);
  if (!['production water', 'production water (hr)', 'pw'].includes(jobType)
      || !pickup || pickup.length > 200 || pickup !== dropoff) throw Error('This is not a same-site PW exception');
  const coord = (value: unknown, max: number) => {
    if (value == null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > max) throw Error('Invalid location coordinates');
    return value;
  };
  const scope = { jobId: raw.jobId, jobType: jobType === 'pw' ? 'production water' : jobType, pickup, dropoff,
    pickupLat: coord(raw.pickupLat, 90), pickupLng: coord(raw.pickupLng, 180),
    dropoffLat: coord(raw.dropoffLat, 90), dropoffLng: coord(raw.dropoffLng, 180) };
  if ((scope.pickupLat == null) !== (scope.pickupLng == null)
      || (scope.dropoffLat == null) !== (scope.dropoffLng == null)) throw Error('Incomplete location coordinates');
  if (scope.pickupLat != null && scope.dropoffLat != null && scope.pickupLng != null && scope.dropoffLng != null) {
    const rad = Math.PI / 180, dLat = (scope.dropoffLat - scope.pickupLat) * rad, dLng = (scope.dropoffLng - scope.pickupLng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(scope.pickupLat * rad) * Math.cos(scope.dropoffLat * rad) * Math.sin(dLng / 2) ** 2;
    if (12742000 * Math.asin(Math.sqrt(Math.min(1, h))) > 500) throw Error('These are different physical locations');
  }
  return scope;
}
export function exceptionBinding(companyId: string, driverId: string, mode: ExceptionMode, scope: ExceptionScope) {
  return JSON.stringify([1, companyId, driverId, mode, scope.jobId, scope.jobType, scope.pickup, scope.dropoff,
    scope.pickupLat, scope.pickupLng, scope.dropoffLat, scope.dropoffLng]);
}
export function maySelfApprove(mode: ExceptionMode) { return mode === 'independent'; }
