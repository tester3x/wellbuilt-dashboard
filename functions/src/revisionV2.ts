// revisionV2.ts — the v2 refresh-signal contract (Phase 2 of the 2026-08-29
// implementation packet).
//
// WHY A NEW NODE: `packets/incoming_version` is a saturated float64
// (~4.3005e20) — `+1` is below the ULP (65,536 at that magnitude), so the
// legacy counter can no longer announce mutations, and it can never be reset
// downward without permanently blinding old clients that persisted the
// saturated value behind a strict-greater comparison.
//
// THE V2 CONTRACT: one small node, replaced atomically INSIDE every committed
// canonical mutation's multi-location update. Clients compare the TOKEN FOR
// INEQUALITY (never numeric order):
//   - changes for every distinct committed mutation: the token is the
//     coordinator receipt's operationId, unique per logical operation
//     (packetId / editEventId / delete_<id>), so two mutations in the same
//     millisecond still produce different tokens;
//   - replay-safe: an idempotent replay short-circuits on the existing receipt
//     and never re-commits, so the token does not change and no false business
//     mutation is signaled;
//   - cross-well/device safe: tokens embed the minted packet identity — no
//     collision, and any change means "refresh your outgoing snapshot";
//   - atomic: written by assembleCanonicalPatch in the SAME update as the
//     business state and the receipt — a failed commit exposes no token;
//   - deliberately minimal ({v, token, at}) — no well name or mutation type,
//     so the fan-out node reveals no business material to other tenants if
//     rules tighten later. Company-scoped nodes were considered and deferred:
//     outgoing consumption is already company-filtered at fetch time, WB-M is
//     single-tenant today, and a per-company fan-out can be added as
//     `packets/incoming_revision_v2_byCompany/<companyId>` without breaking
//     this contract.
//
// THE LEGACY BRIDGE stays on `packets/incoming_version` via the post-commit
// best-effort transaction (incomingVersionPublish.ts), now with a
// representable ULP-aware bump — see nextIncomingVersion. RTDB
// ServerValue.increment was investigated and rejected for the bridge: it is
// float addition server-side, so increment(1) is the same saturated no-op,
// and a fixed larger constant stops being representable as the magnitude
// grows. The transaction updater adapts to the stored magnitude instead.

export const INCOMING_REVISION_V2_PATH = 'packets/incoming_revision_v2';

export interface RevisionV2Node {
  v: 2;
  /** Opaque inequality token — the committed operation's id. */
  token: string;
  /** Coordinator commit time (ms). Informational; NOT an ordering key. */
  at: number;
}

/** Build the node written inside the atomic canonical patch. */
export function buildRevisionV2(receipt: { operationId: string; committedAtMs: number }): RevisionV2Node {
  return { v: 2, token: receipt.operationId, at: receipt.committedAtMs };
}

/**
 * Parse a raw RTDB value into its token, defensively. Accepts the canonical
 * node shape; a bare non-empty string is tolerated (forward compat). Anything
 * else — null, numbers, objects without a string token — is null: consumers
 * must IGNORE malformed values, never sync-loop on them.
 */
export function revisionV2TokenOf(raw: unknown): string | null {
  if (typeof raw === 'string') return raw.trim() || null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const token = (raw as { token?: unknown }).token;
    if (typeof token === 'string' && token.trim()) return token.trim();
  }
  return null;
}
