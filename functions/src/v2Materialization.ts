// v2Materialization.ts — the PURE, deterministic convergence reducer for
// schemaVersion=2 chronological edits, extracted from applyV2ChronologicalEdit's
// transaction so it can be unit-tested in isolation and (once the real emulator is
// available) driven inside the coordinator's serialized buildPatch INSTEAD of the
// live RTDB transaction. It converges ONLY the edited logical pull's editable
// material (editBaseline + editCorrections + materializationRev + materialized
// values); the config-dependent tank derivation and the canonical projections stay
// separate. This component is NOT yet wired to the live handler.
//
// Contract (Codex packet 60427):
//   - preserve EVERY editCorrections entry (never drop a correction);
//   - deterministic: same (state, correction) → same output, byte-for-byte;
//   - same-operation replay is idempotent: re-applying a correction already present
//     with equal values leaves editCorrections unchanged and does NOT bump
//     materializationRev (a real change bumps it monotonically by exactly 1);
//   - correction conflict (two events touching a field) resolves by the canonical
//     chronological materialization, keeping both events in the trail;
//   - concurrent edit intent (two distinct events) converges order-independently;
//   - immutable logical pull identity: packetId is never touched here.
import {
  materializeEditableFields,
  type EditableSnapshot,
  type MaterializableEvent,
} from './editHistory';

/** One accumulated correction, keyed in the row by its editEventId. */
export interface V2CorrectionEntry {
  t: string;              // correctionCreatedAtUTC (client authorship instant)
  v: EditableSnapshot;    // the field values this correction asserts
  e?: string;             // serverReceivedAtUTC
  src?: string;           // edit source
}

export interface V2MaterializationState {
  editBaseline?: EditableSnapshot;
  editCorrections?: Record<string, V2CorrectionEntry>;
  materializationRev?: number;
}

export interface V2IncomingCorrection {
  editEventId: string;
  correctionCreatedAtUTC: string;
  correctionValues: EditableSnapshot;
  serverReceivedAtUTC?: string;
  editSource?: string;
}

export interface V2MaterializationResult {
  editBaseline: EditableSnapshot;
  editCorrections: Record<string, V2CorrectionEntry>;
  materializationRev: number;
  /** The converged editable fields after applying every correction in order. */
  fields: EditableSnapshot;
  /** Which eventId last wrote each field (proof of the conflict resolution). */
  authority: Partial<Record<string, string>>;
  editCount: number;
  /** True when this correction changed the set (a fresh event or changed values);
   *  false on an exact replay. materializationRev only advances when true. */
  changed: boolean;
}

function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Deterministically fold `incoming` into the pull's correction set and return the
 * fully materialized state. Pure — no clock, no IO, no mutation of inputs.
 */
export function materializeV2Correction(
  state: V2MaterializationState,
  frozenBaseline: EditableSnapshot,
  incoming: V2IncomingCorrection,
): V2MaterializationResult {
  const baseline: EditableSnapshot =
    state.editBaseline && typeof state.editBaseline === 'object' ? state.editBaseline : frozenBaseline;
  const existing: Record<string, V2CorrectionEntry> = { ...(state.editCorrections || {}) };

  const entry: V2CorrectionEntry = {
    t: incoming.correctionCreatedAtUTC,
    v: incoming.correctionValues,
    ...(incoming.serverReceivedAtUTC ? { e: incoming.serverReceivedAtUTC } : {}),
    ...(incoming.editSource ? { src: incoming.editSource } : {}),
  };

  const prior = existing[incoming.editEventId];
  const changed = !prior || !stableEqual(prior, entry);

  // Preserve every prior correction; upsert this one by its immutable event id.
  const editCorrections: Record<string, V2CorrectionEntry> = { ...existing, [incoming.editEventId]: entry };

  const events: MaterializableEvent[] = Object.entries(editCorrections).map(([id, c]) => ({
    eventId: id,
    correctionCreatedAtUTC: c.t,
    correctionValues: (c.v || {}) as EditableSnapshot,
  }));
  const mat = materializeEditableFields(baseline, events);

  const materializationRev = (Number(state.materializationRev) || 0) + (changed ? 1 : 0);

  return {
    editBaseline: baseline,
    editCorrections,
    materializationRev,
    fields: mat.fields,
    authority: mat.authority as Partial<Record<string, string>>,
    editCount: Object.keys(editCorrections).length,
    changed,
  };
}
