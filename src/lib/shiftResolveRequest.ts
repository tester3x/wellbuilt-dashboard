/** Deployed staff endpoint accepts driverIds only; tenancy comes from authentication. */
export function shiftResolveRequest(driverIds: string[]) {
  return { driverIds: [...new Set(driverIds.map(id => id.trim()).filter(Boolean))] };
}
