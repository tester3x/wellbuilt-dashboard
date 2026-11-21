/** Independent Dispatch is an operational job package, not a subscription tier. */
export const INDEPENDENT_DISPATCH_PACKAGE_ID = 'independent-dispatch' as const;

/** Evaluated against the server-read company document; never caller-supplied IDs. */
export function hasIndependentDispatchPackage(companyData: unknown): boolean {
  if (!companyData || typeof companyData !== 'object' || Array.isArray(companyData)) return false;
  const activePackages = (companyData as Record<string, unknown>).activePackages;
  return Array.isArray(activePackages)
    && activePackages.some(id => id === INDEPENDENT_DISPATCH_PACKAGE_ID);
}
