// ───────────────────────────────────────────────────────────────────────────
// WB DEFAULT PHOTO REQUIREMENTS (Phase 1 foundation)
//
// The WB-shipped baseline so a brand-new customer/operator works out of the box
// instead of requiring zero photos (the current blank-state bug). Same doc shape
// as photo_requirements/{customerId}.requirements[] — these are seeded into the
// editor (when a customer has no doc) and into the backfill, then persisted so
// the existing runtime loop (WB T load → CF validate) keeps working unchanged.
//
// PHASE 1 SCOPE: defaults + seeding + reset only. NO jobTypes. NO sample images
// required (the CF judges by `description` when no sampleStoragePath is set —
// images can be added per requirement later). PW vs service is the existing
// binary `appliesTo` ('pw' | 'sw'); 'any' would show on both.
//
// IDs are STABLE and meaningful — Reset-to-default matches a requirement to its
// baseline by id, so do NOT renumber these.
//
// ⚠️ CONTENT IS A REVIEWABLE DRAFT. Labels/descriptions/thresholds are sensible
// starting values, not a locked list — tune freely; the structure is what the
// foundation depends on.
//
// Keep in sync with the WB T mirror if/when the app gains a cold-path fallback.
// ───────────────────────────────────────────────────────────────────────────
import type { PhotoRequirement } from './photoRequirements';

export const DEFAULT_PHOTO_REQUIREMENTS: PhotoRequirement[] = [
  // ── Production Water (appliesTo: 'pw') ──────────────────────────────────────
  {
    id: 'pw_well_head',
    label: 'Well Head',
    description: 'The well head / tank battery the load is being pulled from, clearly identifiable.',
    threshold: 80, requiredCount: 1, phase: 'pickup', appliesTo: 'pw', active: true,
    source: 'wb-default',
  },
  {
    id: 'pw_trailer_back',
    label: 'Trailer Back',
    description: 'Rear of the trailer at the pickup, showing the unit and its surroundings.',
    threshold: 80, requiredCount: 1, phase: 'pickup', appliesTo: 'pw', active: true,
    source: 'wb-default',
  },
  {
    id: 'pw_hose_on',
    label: 'Hose On',
    description: 'The transfer hose connected to the tank/getty inlet during loading.',
    threshold: 80, requiredCount: 1, phase: 'pickup', appliesTo: 'pw', active: true,
    source: 'wb-default',
  },
  {
    id: 'pw_open_lid',
    label: 'Open Lid (Getty)',
    description: 'The getty/thief hatch open, showing the fluid level before/while pulling.',
    threshold: 80, requiredCount: 1, phase: 'pickup', appliesTo: 'pw', active: true,
    source: 'wb-default',
  },
  {
    id: 'pw_after_closed_lid',
    label: 'After / Closed Lid',
    description: 'The hatch closed and secured after the pull, proving the tank was left buttoned up.',
    threshold: 80, requiredCount: 1, phase: 'dropoff', appliesTo: 'pw', active: true,
    source: 'wb-default',
  },

  // ── Service-side / non-PW (appliesTo: 'sw') ─────────────────────────────────
  {
    id: 'sw_trailer_back',
    label: 'Trailer Back',
    description: 'Rear of the trailer/unit at the service location.',
    threshold: 80, requiredCount: 1, phase: 'pickup', appliesTo: 'sw', active: true,
    source: 'wb-default',
  },
  {
    id: 'sw_bang_can',
    label: 'Bang Can',
    description: 'The bang can / containment in place at the work area.',
    threshold: 80, requiredCount: 1, phase: 'pickup', appliesTo: 'sw', active: true,
    source: 'wb-default',
  },
  {
    id: 'sw_hose_on',
    label: 'Hose On',
    description: 'The hose connected for the service transfer.',
    threshold: 80, requiredCount: 1, phase: 'pickup', appliesTo: 'sw', active: true,
    source: 'wb-default',
  },
  {
    id: 'sw_worksite',
    label: 'Worksite Proof',
    description: 'The work area showing the job was performed at the correct location.',
    threshold: 80, requiredCount: 1, phase: 'pickup', appliesTo: 'sw', active: true,
    source: 'wb-default',
  },
];

/** Fresh copy of the WB defaults (deep-cloned so callers can mutate safely). */
export function getDefaultPhotoRequirements(): PhotoRequirement[] {
  return DEFAULT_PHOTO_REQUIREMENTS.map((r) => ({ ...r }));
}

/** The WB-default baseline for a single requirement id, or undefined if that id
 *  isn't a WB default (i.e. a customer-created requirement). Used by Reset-one. */
export function defaultRequirementById(id: string): PhotoRequirement | undefined {
  const found = DEFAULT_PHOTO_REQUIREMENTS.find((r) => r.id === id);
  return found ? { ...found } : undefined;
}
