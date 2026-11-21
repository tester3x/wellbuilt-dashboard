export type PackageAction = 'install' | 'remove';

/** Apply one package change to the server's current value, never a stale browser array. */
export function nextCompanyJobPackages(current: unknown, packageId: string, action: PackageAction): string[] {
  if (current === undefined || current === null) current = [];
  if (!Array.isArray(current) || current.length > 32
    || current.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
    || new Set(current).size !== current.length) throw Error('invalid_company_packages');
  if (action === 'install') {
    if (current.includes(packageId)) return current;
    if (current.length === 32) throw Error('package_limit');
    return [...current, packageId];
  }
  if (!current.includes(packageId)) return current;
  if (current.length === 1) throw Error('last_package');
  return current.filter(id => id !== packageId);
}
