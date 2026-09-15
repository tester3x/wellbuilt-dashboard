/**
 * Server-side 5-rule disposal recommendation engine for Route Me.
 *
 * Contract (DASHBOARD-UX-AND-ROUTEME-CONTRACT-20260915.md B3):
 * 1. Build eligible set (company/customer/operator + water type)
 * 2. Exclude swd_directory.isBlacklisted / unavailable
 * 3. Within eligible, prefer authenticated driver's most-common disposal for that canonical well
 * 4. Never globally-closest before filtering
 * 5. Missing eligibility -> "No verified drop-off"
 */

export const NO_VERIFIED_DROPOFF = 'No verified drop-off' as const;

export interface DisposalRecord {
  id?: string;
  name?: string;
  well_name?: string;
  companyId?: string;
  operator?: string;
  waterType?: string;
  isBlacklisted?: boolean;
  blacklisted?: boolean;
  unavailable?: boolean;
  active?: boolean;
  status?: string;
  lat?: number;
  lng?: number;
}

export interface WellDisposalContext {
  wellName: string;
  companyId: string;
  wellId?: string;
  operator?: string;
  customer?: string;
  waterType?: string;
  preferredDisposal?: string;
}

export interface DriverDisposalPreference {
  /** Driver's historical most-used disposal name for this specific well. */
  mostCommonDisposalName?: string | null;
  /** Frequency map of disposalName -> count for this driver + well. */
  disposalFrequencies?: Record<string, number>;
}

/**
 * Filter and recommend the best disposal under the 5-rule engine.
 */
export function recommendDisposal(
  disposals: DisposalRecord[],
  well: WellDisposalContext,
  driverPref?: DriverDisposalPreference,
): string {
  if (!disposals || !Array.isArray(disposals) || disposals.length === 0) {
    return NO_VERIFIED_DROPOFF;
  }

  // 1. Build eligible set (Rules 1 & 2):
  const eligible = disposals.filter((d) => {
    const dispName = (d.well_name || d.name || '').trim();
    if (!dispName) return false;

    // Rule 2: Exclude blacklisted, inactive, or unavailable
    if (d.isBlacklisted === true || d.blacklisted === true) return false;
    if (d.unavailable === true) return false;
    if (d.active === false) return false;
    if (typeof d.status === 'string' && (d.status.toLowerCase() === 'blacklisted' || d.status.toLowerCase() === 'unavailable')) {
      return false;
    }

    // Rule 1: Tenant / customer / waterType eligibility
    // If disposal has an explicit companyId, it must match the well/driver company
    if (d.companyId && d.companyId.trim() && d.companyId.trim() !== well.companyId) {
      return false;
    }

    // Water type matching if both specify it
    if (d.waterType && well.waterType && d.waterType.trim().toLowerCase() !== well.waterType.trim().toLowerCase()) {
      return false;
    }

    return true;
  });

  // Rule 5: If no eligible disposals survive, fail safe
  if (eligible.length === 0) {
    return NO_VERIFIED_DROPOFF;
  }

  // Helper to match disposal by name
  const eligibleNames = new Set(eligible.map((d) => (d.well_name || d.name || '').trim()));

  // Rule 3: Within eligible, prefer driver's most frequent disposal for this canonical well
  if (driverPref?.mostCommonDisposalName && eligibleNames.has(driverPref.mostCommonDisposalName.trim())) {
    return driverPref.mostCommonDisposalName.trim();
  }

  if (driverPref?.disposalFrequencies) {
    let topName: string | null = null;
    let topCount = -1;
    for (const [name, count] of Object.entries(driverPref.disposalFrequencies)) {
      if (eligibleNames.has(name) && count > topCount) {
        topName = name;
        topCount = count;
      }
    }
    if (topName) return topName;
  }

  // If well has a preferred/default disposal in config and it is eligible
  if (well.preferredDisposal && eligibleNames.has(well.preferredDisposal.trim())) {
    return well.preferredDisposal.trim();
  }

  // Fallback within eligible set (first eligible)
  const first = (eligible[0].well_name || eligible[0].name || '').trim();
  return first || NO_VERIFIED_DROPOFF;
}
