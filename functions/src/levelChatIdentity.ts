// levelChatIdentity.ts
// Deterministic, server-authoritative, company-scoped identity resolution for
// the automated level-report → chat pipeline (sendLevelToChat).
//
// WHY: automated level reports silently stopped delivering because the pull
// packet's `driverId` migrated to the CANONICAL id (a drivers/profiles key),
// while sendLevelToChat pre-gated on drivers/approved/{driverId}.companyId and
// matched chat threads on `driver:${driverId}`. Canonical-plane pulls therefore
// hit `drivers/approved/{canonicalId}` — a thin record with NO companyId — and
// returned at the companyId gate before ever reaching the feature toggle.
//
// This module resolves the packet driverId to {companyId, driverName,
// participantIds} using ONLY keyed reads (approved first, then profiles) — no
// heuristic global scans and no guessing from name/email/phone. It also emits a
// stable reason code for every non-send outcome so skips are observable instead
// of silent. It is Firebase-free (readers are injected) so it is unit-testable.

export const LEVEL_CHAT_REASON = {
  NO_DRIVER_ID: 'no_driver_id',
  DRIVER_UNRESOLVED: 'driver_identity_unresolved',
  NO_COMPANY: 'no_company_id',
  FEATURE_DISABLED: 'feature_disabled',
  NO_DIRECT_THREADS: 'no_direct_threads',
  NO_DISPATCH_THREADS: 'no_dispatch_threads',
  ALREADY_SENT: 'already_sent',
  SENT: 'sent',
} as const;
export type LevelChatReason = typeof LEVEL_CHAT_REASON[keyof typeof LEVEL_CHAT_REASON];

export interface ResolvedLevelChatDriver {
  companyId: string;
  driverName: string;
  /** Chat participant ids to match against (canonical + any explicit legacy alias). */
  participantIds: string[];
  /** Which server record supplied the companyId. */
  source: 'approved' | 'profiles';
}

export type ResolveResult =
  | { ok: true; driver: ResolvedLevelChatDriver }
  | { ok: false; reason: typeof LEVEL_CHAT_REASON.NO_DRIVER_ID | typeof LEVEL_CHAT_REASON.NO_COMPANY | typeof LEVEL_CHAT_REASON.DRIVER_UNRESOLVED };

interface DriverRecordReaders {
  /** RTDB drivers/approved/{id} value or null. */
  readApproved: (id: string) => Promise<Record<string, unknown> | null | undefined>;
  /** RTDB drivers/profiles/{id} value or null. */
  readProfile: (id: string) => Promise<Record<string, unknown> | null | undefined>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/**
 * Chat-thread participant ids to try for this driver. Always includes
 * `driver:${driverId}` (the packet id). Includes an explicit legacy/canonical
 * alias ONLY when the identity record deterministically carries the full id —
 * never derived, scanned, or guessed. (Today profiles carry only an 8-char
 * `migratedFromLegacyHashPrefix`, which is intentionally NOT used because it is
 * not a full, collision-safe id; when the identity lane stamps a full
 * `legacyHash`/`canonicalId`, this picks it up automatically.)
 */
export function participantAliasSet(driverId: string, rec: Record<string, unknown> | null | undefined): string[] {
  const ids = new Set<string>([`driver:${driverId}`]);
  const legacy = rec && (str(rec.legacyHash) || str(rec.legacyDriverHash));
  if (legacy && legacy.length >= 32) ids.add(`driver:${legacy}`);
  const canonical = rec && (str(rec.canonicalId) || str(rec.canonicalDriverId));
  if (canonical && canonical.length >= 32 && canonical !== driverId) ids.add(`driver:${canonical}`);
  return [...ids];
}

function nameFrom(rec: Record<string, unknown>, fallback?: string): string {
  return str(rec.legalName) || str(rec.displayName) || str((rec.profile as Record<string, unknown> | undefined)?.legalName)
    || fallback || 'Driver';
}

/**
 * Resolve the packet driverId to a company-scoped chat identity.
 * Order: drivers/approved/{id}.companyId (legacy plane) → drivers/profiles/{id}.companyId
 * (canonical plane). Both are server-owned identity records (authoritative);
 * the raw packet is never trusted for authorization.
 */
export async function resolveLevelChatDriver(
  driverId: string | undefined | null,
  readers: DriverRecordReaders,
  opts?: { fallbackName?: string },
): Promise<ResolveResult> {
  const id = str(driverId ?? undefined);
  if (!id) return { ok: false, reason: LEVEL_CHAT_REASON.NO_DRIVER_ID };

  const approved = (await readers.readApproved(id)) || null;
  if (approved && str(approved.companyId)) {
    return {
      ok: true,
      driver: {
        companyId: String(approved.companyId),
        driverName: nameFrom(approved, opts?.fallbackName),
        participantIds: participantAliasSet(id, approved),
        source: 'approved',
      },
    };
  }

  const profile = (await readers.readProfile(id)) || null;
  if (profile && str(profile.companyId)) {
    return {
      ok: true,
      driver: {
        companyId: String(profile.companyId),
        driverName: nameFrom(profile, opts?.fallbackName),
        // prefer the profile's explicit aliases; fall back to the (thin) approved rec's
        participantIds: participantAliasSet(id, { ...(approved || {}), ...profile }),
        source: 'profiles',
      },
    };
  }

  // Distinguish "record exists but unusable (no companyId)" from "no record at all".
  if (approved || profile) return { ok: false, reason: LEVEL_CHAT_REASON.NO_COMPANY };
  return { ok: false, reason: LEVEL_CHAT_REASON.DRIVER_UNRESOLVED };
}

/**
 * Deterministic message doc id for a (packet, thread) pair. Reusing it as the
 * Firestore doc id makes a reprocessed pull idempotent (same id → no duplicate),
 * and lets the sender skip a thread it has already posted to (ALREADY_SENT).
 */
export function levelReportMessageId(packetId: string, threadId: string): string {
  const safe = (s: string) => String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 90);
  return `lvl_${safe(packetId)}_${safe(threadId)}`;
}

/** Coarse form of a driver id for sanitized diagnostics (never logs the full id). */
export function driverIdForm(id: string | undefined | null): string {
  if (!id) return 'none';
  const n = String(id).length;
  if (n === 36) return 'canonical(36)';
  if (n === 64) return 'legacyHash(64)';
  return `other(${n})`;
}
