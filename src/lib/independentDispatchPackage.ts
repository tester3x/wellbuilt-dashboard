/** Package-driven UI availability; subscription tier is a separate concern. */
export const INDEPENDENT_DISPATCH_PACKAGE_ID = 'independent-dispatch' as const;

/** Fail closed for missing or malformed company package configuration. */
export function hasIndependentDispatchPackage(activePackages: unknown): boolean {
  return Array.isArray(activePackages)
    && activePackages.some(id => id === INDEPENDENT_DISPATCH_PACKAGE_ID);
}

/** This company has no other job package that uses the standard workspace. */
export function hasOnlyIndependentDispatchPackage(activePackages: unknown): boolean {
  return Array.isArray(activePackages)
    && activePackages.length === 1
    && activePackages[0] === INDEPENDENT_DISPATCH_PACKAGE_ID;
}

/** A self-service owner before installing any operational job package. */
export function hasFreeOwnerWorkspace(company: {
  id: string; ownerUid?: string; activePackages?: string[];
  wellbuiltContract?: { planId?: string };
} | null, uid: string | undefined): boolean {
  return !!company && !!uid && company.ownerUid === uid
    && company.wellbuiltContract?.planId === `free-${company.id.replace(/_/g, '-')}`
    && (!Array.isArray(company.activePackages) || company.activePackages.length === 0);
}
