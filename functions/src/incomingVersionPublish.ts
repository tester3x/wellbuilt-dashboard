// Legacy revision contract for `packets/incoming_version` — ATOMIC edition.
//
// HISTORY: the node is a saturated float64 (~4.3005e20, production evidence
// 2026-08-28): its ULP is 65,536, so the historic `current + 1` transaction
// was a permanent no-op, and old clients persist the saturated value behind a
// strict-greater comparison that a downward reset would blind forever.
//
// PHASE-2 first bridged it with a post-commit ULP-aware transaction; the
// completion audit rejected post-commit publication (crash window: business
// state commits, worker dies, old clients never hear about it). The bridge is
// now a SERVER-SIDE INCREMENT SENTINEL inside the SAME atomic multi-location
// update as the business state, receipt, incoming removal, and v2 token:
//
//   patch['packets/incoming_version'] = { '.sv': { increment: 2^20 } }
//
// WHY 2^20 (1,048,576) and not +1 or one ULP:
//   - a fixed sentinel value must be chosen BEFORE the server applies it, so
//     it cannot adapt to the stored magnitude the way the old transaction
//     updater could;
//   - +1 is below the ULP at the production magnitude → no-op;
//   - exactly one ULP (65,536) stops producing a guaranteed change as soon as
//     the magnitude doubles (round-to-nearest ties at half-ULP);
//   - 2^20 = 16 ULPs at today's magnitude. Round-to-nearest changes any
//     double v whenever the added constant exceeds half of ULP(v); with
//     bump = 2^20 that holds for every v with ULP(v) ≤ 2^21, i.e. all
//     v < 2^73 ≈ 9.44e21 — 22× the saturated value, unreachable by adding
//     2^20 per mutation (≈ 8.6e15 mutations away). Monotonic and observable
//     for the life of the node.
//   - RTDB applies increment sentinels server-side against the then-current
//     value atomically per write, so concurrent cross-well commits cannot
//     lose a bump.
//
// Replay/refusal safety comes from the coordinator: an idempotent replay
// short-circuits on the receipt and never submits a patch; a refusal or
// collision never reaches the patch — so the node moves exactly once per
// distinct committed canonical mutation.

export const LEGACY_INCOMING_VERSION_PATH = 'packets/incoming_version';

/** 2^20 — see the header for the proof obligations this satisfies. */
export const LEGACY_REVISION_BUMP = 1 << 20;

/** Bound under which the bump provably changes the stored double. */
export const LEGACY_BUMP_VALID_BELOW = Math.pow(2, 73);

/**
 * The raw RTDB server-value increment sentinel, exactly what
 * admin.database.ServerValue.increment(LEGACY_REVISION_BUMP) produces —
 * constructed literally so canonicalPatch stays pure and unit-testable.
 */
export function legacyRevisionIncrement(): { '.sv': { increment: number } } {
  return { '.sv': { increment: LEGACY_REVISION_BUMP } };
}

/**
 * Pure model of the server-side application (for proofs/tests): IEEE-754
 * double addition, which is what the RTDB server and emulator perform.
 */
export function applyLegacyBump(current: unknown): number {
  const n = typeof current === 'number' && Number.isFinite(current) ? current : 0;
  return n + LEGACY_REVISION_BUMP;
}
