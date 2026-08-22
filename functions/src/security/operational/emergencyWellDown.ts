/**
 * Emergency well mark-down — decision logic.
 *
 * Why this exists at all. The only authoritative way to mark a well down today
 * is an EDIT packet (`src/lib/wells.ts` markWellDown): `requestType: 'edit'`
 * carrying `tankTopInches` and `bblsTaken`, which `processEditRequest` applies
 * ON TOP OF the original pull. That is a correction to recorded history. When
 * the intent is "the last pull is still exactly right, we simply cannot get a
 * new one", rewriting that pull is the wrong instrument — it edits a fact that
 * is not wrong.
 *
 * So this operation touches two booleans and nothing else:
 *   wells/{well}/status/isDown        -> true
 *   packets/outgoing/{responseId}/wellDown -> true
 *
 * It does not create, replace, backdate or amend a pull packet, does not write
 * edit history, and leaves lastPullBottomLevel, lastPullDateTimeUTC,
 * avgFlowRate and avgFlowRateMinutes untouched. When WB-M resumes, the driver's
 * next real pull arrives through the normal path, clears the flag by the
 * existing authoritative rule, and rebaselines the estimate on its own level and
 * timestamp. No fabricated packet and no manual rebaseline are needed.
 *
 * NO SCAN, on purpose — the same rule the retro-close migration follows. The
 * caller names each well AND states the last pull it reviewed. The server's job
 * is to REFUSE when that evidence no longer holds. If a driver pulls a well
 * between Preview and Apply, that well is refused rather than marked down on
 * stale evidence, which is the one mistake this operation could make that would
 * hide a live well from a driver.
 */

/** A single well the caller is asking to mark down, with the evidence they saw. */
export interface EmergencyWellDownTarget {
  wellName: string;
  /** lastPullDateTimeUTC exactly as shown in the Preview the caller reviewed. */
  expectedLastPullUTC: string;
}

/** Live state read at decision time. */
export interface EmergencyWellDownObservation {
  /** The outgoing response row, or null when the well has none. */
  outgoing: {
    responseId: string;
    wellName?: string;
    wellDown?: boolean;
    isDown?: boolean;
    lastPullDateTimeUTC?: string;
    lastPullBottomLevel?: string;
    currentLevel?: string;
  } | null;
  /** wells/{well}/status/isDown as currently stored. */
  statusIsDown: boolean;
  /** well_config fields, echoed into the preview so the reviewer sees them. */
  config: {
    companyId?: string;
    avgFlowRate?: string;
    avgFlowRateMinutes?: number;
  };
}

export type EmergencyWellDownAction =
  | 'mark_down'
  | 'skip_already_down'
  | 'refuse_missing_status'
  | 'refuse_evidence_mismatch';

export interface EmergencyWellDownDecision {
  wellName: string;
  action: EmergencyWellDownAction;
  reason: string;
  /** Paths this well would write. Empty unless action === 'mark_down'. */
  willWrite: string[];
  /** Everything the reviewer needs, echoed from live state. */
  observed: {
    companyId: string | null;
    wellDown: boolean;
    lastPullDateTimeUTC: string | null;
    lastPullBottomLevel: string | null;
    currentLevel: string | null;
    avgFlowRate: string | null;
    avgFlowRateMinutes: number | null;
  };
}

/**
 * Decide one well. Pure: same inputs, same decision, no clock and no I/O.
 *
 * Order matters. "Already down" is checked before the evidence match so a well
 * someone else marked down in the meantime is reported as a harmless skip
 * rather than an alarming refusal.
 */
export function decideEmergencyWellDown(
  target: EmergencyWellDownTarget,
  observed: EmergencyWellDownObservation,
): EmergencyWellDownDecision {
  const o = observed.outgoing;
  const base = {
    wellName: target.wellName,
    observed: {
      companyId: observed.config.companyId ?? null,
      wellDown: o?.wellDown === true || o?.isDown === true || observed.statusIsDown === true,
      lastPullDateTimeUTC: o?.lastPullDateTimeUTC ?? null,
      lastPullBottomLevel: o?.lastPullBottomLevel ?? null,
      currentLevel: o?.currentLevel ?? null,
      avgFlowRate: observed.config.avgFlowRate ?? null,
      avgFlowRateMinutes:
        typeof observed.config.avgFlowRateMinutes === 'number'
          ? observed.config.avgFlowRateMinutes
          : null,
    },
  };

  if (!o) {
    return {
      ...base,
      action: 'refuse_missing_status',
      reason: 'no outgoing status row for this well',
      willWrite: [],
    };
  }

  if (o.wellDown === true || o.isDown === true || observed.statusIsDown === true) {
    return { ...base, action: 'skip_already_down', reason: 'already marked down', willWrite: [] };
  }

  // The evidence gate. An exact match is required: any newer pull, any edit that
  // moved the timestamp, or a well the caller never actually reviewed, all land
  // here and are refused rather than guessed at.
  if (
    typeof o.lastPullDateTimeUTC !== 'string' ||
    o.lastPullDateTimeUTC !== target.expectedLastPullUTC
  ) {
    return {
      ...base,
      action: 'refuse_evidence_mismatch',
      reason:
        `last pull is ${o.lastPullDateTimeUTC ?? '(none)'}, ` +
        `caller reviewed ${target.expectedLastPullUTC}`,
      willWrite: [],
    };
  }

  return {
    ...base,
    action: 'mark_down',
    reason: 'no replacement pull possible during the WB-M outage; last pull is the trustworthy boundary',
    willWrite: [
      `wells/${target.wellName}/status/isDown`,
      `packets/outgoing/${o.responseId}/wellDown`,
    ],
  };
}

export interface EmergencyWellDownPlan {
  dryRun: boolean;
  decisions: EmergencyWellDownDecision[];
  counts: Record<EmergencyWellDownAction, number>;
  willWriteCount: number;
}

/** Roll individual decisions into the plan the caller sees. */
export function buildEmergencyWellDownPlan(
  decisions: EmergencyWellDownDecision[],
  dryRun: boolean,
): EmergencyWellDownPlan {
  const counts: Record<EmergencyWellDownAction, number> = {
    mark_down: 0,
    skip_already_down: 0,
    refuse_missing_status: 0,
    refuse_evidence_mismatch: 0,
  };
  for (const d of decisions) counts[d.action] += 1;
  return {
    dryRun,
    decisions,
    counts,
    willWriteCount: decisions.filter((d) => d.action === 'mark_down').length,
  };
}

/** Reject malformed input before any read. Bounded, and never path-injecting. */
export function parseEmergencyWellDownTargets(raw: unknown): EmergencyWellDownTarget[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('targets_required');
  if (raw.length > 200) throw new Error('too_many_targets');
  const seen = new Set<string>();
  return raw.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const wellName = e.wellName;
    const expectedLastPullUTC = e.expectedLastPullUTC;
    if (typeof wellName !== 'string' || !wellName.trim() || wellName.length > 120) {
      throw new Error('invalid_wellName');
    }
    // RTDB path segments: a slash or control character would escape the node.
    if (/[/.#$[\]]/.test(wellName)) throw new Error('invalid_wellName');
    if (typeof expectedLastPullUTC !== 'string' || !expectedLastPullUTC.trim()) {
      throw new Error('invalid_expectedLastPullUTC');
    }
    if (Number.isNaN(Date.parse(expectedLastPullUTC))) throw new Error('invalid_expectedLastPullUTC');
    if (seen.has(wellName)) throw new Error('duplicate_well');
    seen.add(wellName);
    return { wellName, expectedLastPullUTC };
  });
}
