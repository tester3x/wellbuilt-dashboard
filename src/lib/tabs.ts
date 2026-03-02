import type { UserRole } from './auth';

export interface TabConfig {
  id: string;
  label: string;
  href: string;
  matchPrefixes: string[];
  minRole?: UserRole;  // minimum role level to see this tab
}

export const TABS: TabConfig[] = [
  {
    id: 'home',
    label: 'Home',
    href: '/',
    matchPrefixes: ['/'],
  },
  {
    id: 'mobile',
    label: 'WB Mobile',
    href: '/mobile',
    matchPrefixes: ['/mobile', '/well', '/performance'],
  },
  {
    id: 'tickets',
    label: 'WB Tickets',
    href: '/tickets',
    matchPrefixes: ['/tickets'],
  },
  {
    id: 'dispatch',
    label: 'Dispatch',
    href: '/dispatch',
    matchPrefixes: ['/dispatch'],
  },
  {
    id: 'billing',
    label: 'WB Billing',
    href: '/billing',
    matchPrefixes: ['/billing'],
  },
  {
    id: 'payroll',
    label: 'WB Payroll',
    href: '/payroll',
    matchPrefixes: ['/payroll'],
  },
  {
    id: 'settings',
    label: 'Settings',
    href: '/settings',
    matchPrefixes: ['/settings'],
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
