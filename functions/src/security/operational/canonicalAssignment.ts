/**
 * Canonical driver assignment contract.
 *
 * Authority lives only on drivers/profiles/{driverId}:
 *   assignedRoutes: string[] | <missing>
 *   assignedWells:  string[] | <missing>
 *
 * Company-driver semantics:
 *   real route OR explicit assigned well → eligible, scoped
 *   explicit [] / Unrouted-only / no wells                 → ineligible
 *   both fields missing                                    → unknown (assignment_unavailable)
 *
 * Missing must NEVER grant all company wells.
 * Empty arrays must NEVER grant all company wells.
 * No-company admin unrestricted access is a separate explicit policy
 * (not implemented here; getDriverWellConfig still requires companyId).
 */

export type AssignmentStatus = 'eligible' | 'ineligible' | 'unknown';

export type AssignmentEvaluation = {
  status: AssignmentStatus;
  reason: string;
  routesPresent: boolean;
  wellsPresent: boolean;
  routes: string[];
  wells: string[];
};

export type WellConfigRow = Record<string, unknown> & {
  wellName?: string;
  companyId?: string;
  route?: string;
};

export type WellConfigSelection = {
  status: 'scoped' | 'ineligible' | 'assignment_unavailable' | 'no_company';
  reason: string;
  wells: Record<string, WellConfigRow>;
};

export function normalizeAssignmentField(raw: unknown): { present: boolean; values: string[] } {
  if (raw === undefined || raw === null) return { present: false, values: [] };
  if (!Array.isArray(raw)) return { present: false, values: [] };
  const values = raw
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return { present: true, values };
}

export function isRealRouteName(route: string): boolean {
  return !route.startsWith('Unrouted');
}

export function evaluateCanonicalAssignment(input: {
  assignedRoutes?: unknown;
  assignedWells?: unknown;
}): AssignmentEvaluation {
  const routes = normalizeAssignmentField(input.assignedRoutes);
  const wells = normalizeAssignmentField(input.assignedWells);

  if (!routes.present && !wells.present) {
    return {
      status: 'unknown',
      reason: 'assignment_unavailable',
      routesPresent: false,
      wellsPresent: false,
      routes: [],
      wells: [],
    };
  }

  const hasRealRoute = routes.present && routes.values.some(isRealRouteName);
  const hasWell = wells.present && wells.values.length > 0;

  if (hasRealRoute || hasWell) {
    return {
      status: 'eligible',
      reason: hasRealRoute ? 'real_route' : 'assigned_wells',
      routesPresent: routes.present,
      wellsPresent: wells.present,
      routes: routes.present ? routes.values : [],
      wells: wells.present ? wells.values : [],
    };
  }

  const reason =
    routes.present && routes.values.length > 0 && !hasRealRoute && !hasWell
      ? 'unrouted_only'
      : 'explicit_empty';

  return {
    status: 'ineligible',
    reason,
    routesPresent: routes.present,
    wellsPresent: wells.present,
    routes: routes.present ? routes.values : [],
    wells: wells.present ? wells.values : [],
  };
}

export function assignmentFieldForClient(raw: unknown): string[] | null {
  const n = normalizeAssignmentField(raw);
  return n.present ? n.values : null;
}

function routeMatches(assignedRoute: string, wellRoute: string): boolean {
  if (assignedRoute === 'Unrouted') return wellRoute.startsWith('Unrouted');
  return assignedRoute.toLowerCase() === wellRoute.toLowerCase();
}

/**
 * Scope well_config to the canonical assignment. Never returns the full
 * company catalog for a company driver.
 */
export function selectAssignedWellConfig(input: {
  catalog: Record<string, WellConfigRow | null | undefined>;
  companyId: string;
  assignedRoutes?: unknown;
  assignedWells?: unknown;
}): WellConfigSelection {
  const companyId = (input.companyId || '').trim();
  if (!companyId) {
    return { status: 'no_company', reason: 'company_required', wells: {} };
  }

  const evaln = evaluateCanonicalAssignment({
    assignedRoutes: input.assignedRoutes,
    assignedWells: input.assignedWells,
  });

  if (evaln.status === 'unknown') {
    return { status: 'assignment_unavailable', reason: evaln.reason, wells: {} };
  }
  if (evaln.status === 'ineligible') {
    return { status: 'ineligible', reason: evaln.reason, wells: {} };
  }

  const routeAllow = evaln.routesPresent ? evaln.routes : [];
  const wellAllow = evaln.wellsPresent
    ? evaln.wells.map((w) => w.toLowerCase())
    : [];
  const out: Record<string, WellConfigRow> = {};

  for (const [wellName, raw] of Object.entries(input.catalog || {})) {
    if (!raw || typeof raw !== 'object') continue;
    const rowCompany = typeof raw.companyId === 'string' ? raw.companyId.trim() : '';
    if (!rowCompany || rowCompany !== companyId) continue;
    const wellRoute = typeof raw.route === 'string' ? raw.route : '';
    const wellMatch = wellAllow.length > 0 && wellAllow.includes(wellName.toLowerCase());
    const routeMatch =
      routeAllow.length > 0 &&
      routeAllow.some((assigned) => routeMatches(assigned, wellRoute));
    if (wellMatch || routeMatch) {
      out[wellName] = { ...raw, wellName, companyId };
    }
  }

  return { status: 'scoped', reason: evaln.reason, wells: out };
}
