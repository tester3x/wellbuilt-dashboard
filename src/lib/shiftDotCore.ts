/**
 * Driver shift-dot semantics — pure, node-testable.
 *
 * The dot reflects ONLY the governed WB-S active-shift authority
 * (`driver_shift_authority/{canonicalDriverId}`, resolved server-side by
 * `decideResolve`), matched by companyId + canonical driverId:
 *
 *   - green : authoritative OPEN company shift            (resolve state 'open')
 *   - red   : authoritative confirmation of NO open shift (resolve state 'none')
 *   - gray  : unresolved / loading / error / unavailable  (state 'unverifiable',
 *             missing, cross-company, or the governed reader not yet callable)
 *
 * It MUST NOT be derived from HOS legality, login name, online/device presence,
 * GPS freshness, active/idle job, or automated-routing availability. An
 * illegal-length but still-open shift is still green. A hydration/read failure is
 * gray, NEVER a false red.
 *
 * Identity: matched by companyId + canonical driverId only — never a login alias,
 * display name, legacy hash, auth UID, or list index.
 */

export type ShiftResolveState = 'open' | 'none' | 'unverifiable';

/** The governed resolve result (mirrors functions `decideResolve` + protocol). */
export interface ShiftResolveResult {
  state: ShiftResolveState;
  periodId?: string;
  originLocalDate?: string;
  reason?: string;
}

export type ShiftDot = 'green' | 'red' | 'gray';

export interface ShiftDotView {
  dot: ShiftDot;
  /** Accessible label/title. */
  title: 'On shift' | 'Off shift' | 'Shift status unavailable';
  symbol: '🟢' | '🔴' | '⚪';
}

const VIEW: Record<ShiftDot, ShiftDotView> = {
  green: { dot: 'green', title: 'On shift', symbol: '🟢' },
  red: { dot: 'red', title: 'Off shift', symbol: '🔴' },
  gray: { dot: 'gray', title: 'Shift status unavailable', symbol: '⚪' },
};

/** Map a governed resolve result (or absence) to a dot. Absence/unknown ⇒ gray. */
export function shiftDotFromResolve(result: ShiftResolveResult | null | undefined): ShiftDotView {
  if (!result) return VIEW.gray;
  switch (result.state) {
    case 'open': return VIEW.green;
    case 'none': return VIEW.red;
    default: return VIEW.gray; // 'unverifiable' and anything unexpected
  }
}

/**
 * The dot for one driver, looked up from a governed result map keyed by canonical
 * driverId. Cross-company or missing canonical id ⇒ gray (never another company's
 * or another driver's state). `loading`/`error` ⇒ gray.
 */
export function shiftDotForDriver(input: {
  canonicalDriverId?: string | null;
  companyId?: string | null;
  resultsByDriverId?: Map<string, ShiftResolveResult> | null;
  /** Company the results were resolved for — must match the driver's company. */
  resolvedCompanyId?: string | null;
  loading?: boolean;
  error?: boolean;
}): ShiftDotView {
  if (input.loading || input.error) return VIEW.gray;
  const id = typeof input.canonicalDriverId === 'string' ? input.canonicalDriverId.trim() : '';
  if (!id) return VIEW.gray; // no canonical identity to join on — never guess
  // Never accept a result resolved for a different company.
  const dc = typeof input.companyId === 'string' ? input.companyId.trim() : '';
  const rc = typeof input.resolvedCompanyId === 'string' ? input.resolvedCompanyId.trim() : '';
  if (dc && rc && dc !== rc) return VIEW.gray;
  const result = input.resultsByDriverId?.get(id) ?? null;
  return shiftDotFromResolve(result);
}
