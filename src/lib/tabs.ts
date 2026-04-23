import type { Capability, UserRole } from './auth';

export interface TabConfig {
  id: string;
  label: string;
  href: string;
  matchPrefixes: string[];
  /**
   * Capability required to see this tab. When set, visible only if
   * hasCapability(user, capability, companyConfig) === true. Unset = always.
   * Prefer this over minRole in new code.
   */
  capability?: Capability;
  /** Legacy role gate — kept for backwards-compat, ignored when `capability` is set. */
  minRole?: UserRole;
}

export const TABS: TabConfig[] = [
  {
    id: 'home',
    label: 'Home',
    href: '/',
    matchPrefixes: ['/'],
    // Always visible (no capability gate)
  },
  {
    id: 'mobile',
    label: 'WB Mobile',
    href: '/mobile',
    matchPrefixes: ['/mobile', '/well', '/performance'],
    capability: 'viewMobile',
  },
  {
    id: 'tickets',
    label: 'WB Tickets',
    href: '/tickets',
    matchPrefixes: ['/tickets'],
    capability: 'viewTickets',
  },
  {
    id: 'dispatch',
    label: 'Dispatch',
    href: '/dispatch',
    matchPrefixes: ['/dispatch'],
    capability: 'viewDispatch',
  },
  {
    id: 'billing',
    label: 'WB Billing',
    href: '/billing',
    matchPrefixes: ['/billing'],
    capability: 'viewBilling',
  },
  {
    id: 'payroll',
    label: 'WB Payroll',
    href: '/payroll',
    matchPrefixes: ['/payroll'],
    capability: 'viewPayroll',
  },
  {
    id: 'driverlogs',
    label: 'Driver Logs',
    href: '/driverlogs',
    matchPrefixes: ['/driverlogs'],
    capability: 'viewDriverLogs',
  },
  {
    id: 'settings',
    label: 'Settings',
    href: '/settings',
    matchPrefixes: ['/settings'],
    capability: 'viewSettings',
    minRole: 'admin',
  },
];

export function getActiveTab(pathname: string): string | null {
  if (pathname === '/') return 'home';

  // Check non-root prefixes first (more specific)
  for (const tab of TABS) {
    for (const prefix of tab.matchPrefixes) {
      if (prefix !== '/' && pathname.startsWith(prefix)) return tab.id;
    }
  }

  // No match (e.g. /admin, /login) — no tab highlighted
  return null;
}
