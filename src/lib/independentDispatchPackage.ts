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
