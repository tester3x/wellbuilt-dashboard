import * as httpsV2 from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireAdminRole } from './requireAdminRole';
import { normalizedSwdNameToSafeKey } from './loadSwdReferenceRuntime';
import { normalizeLocationNameForOfficialMatch } from '../truth-layer/normalizeOfficialLocationName';

interface RawRequest {
  /** Required. Raw display name of the SWD/disposal to promote. */
  name?: string;
}

interface ParsedRequest {
  rawName: string;
  normalizedName: string;
  safeKey: string;
}

function parseRequest(data: unknown): ParsedRequest {
  const req = (data ?? {}) as RawRequest;
  const rawName =
    typeof req.name === 'string' ? req.name.trim() : '';
  if (!rawName) {
    throw new HttpsError('invalid-argument', 'Missing required `name`.');
  }
  if (rawName.length > 200) {
    // Sanity cap — SWD names are short. Prevents pathological writes.
    throw new HttpsError(
      'invalid-argument',
      '`name` is unreasonably long (>200 chars).'
    );
  }
  const normalizedName = normalizeLocationNameForOfficialMatch(rawName);
  if (!normalizedName) {
    throw new HttpsError(
      'invalid-argument',
      '`name` normalizes to empty — supply at least one alphanumeric character.'
    );
  }
  return {
    rawName,
    normalizedName,
    safeKey: normalizedSwdNameToSafeKey(normalizedName),
  };
}

/**
 * Phase 21 — promote a single SWD/disposal name into the runtime SWD
 * catalog.
 *
 * Admin-gated (requireAdminRole -> admin | it). Writes:
 *   truth_reference/swd_catalog/{safeKey}
 *
 * where `safeKey = normalizedSwdNameToSafeKey(normalizedName)` so
 * reads and writes never drift in format.
 *
 * Record fields:
 *   name           — raw display form as typed by the admin
 *   normalizedName — Phase 18 normalized form, used for match-set
 *                    construction on the read path
 *   type           — always 'swd'
 *   addedAt        — ISO 8601 server timestamp at write time
 *   addedByUid     — uid from requireAdminRole
 *   addedByEmail?  — email if available on the user profile
 *   active         — always true on create; re-add of an existing
 *                    safeKey overwrites the full record via .set()
 *
 * Idempotent by safeKey collision: re-adding the same name (or
 * another name that normalizes to the same safeKey) overwrites the
 * prior record with a fresh timestamp. That's desirable — it's a
 * refresh, not a duplicate.
 *
 * Source truth is NEVER touched. No canonicalLocations, preferredName,
 * aliases, invoices, dispatches, jsas, well_config, etc. are modified
 * by this callable. It only persists a sidecar reference entry that
 * the read path folds in via `buildSwdReferenceSet()`.
 */
export const addTruthSwdReference = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const identity = await requireAdminRole(request);
    const { rawName, normalizedName, safeKey } = parseRequest(request.data);

    const record: {
      name: string;
      normalizedName: string;
      type: 'swd';
      addedAt: string;
      addedByUid: string;
      addedByEmail?: string;
      active: true;
    } = {
      name: rawName,
      normalizedName,
      type: 'swd',
      addedAt: new Date().toISOString(),
      addedByUid: identity.uid,
      active: true,
    };
    if (identity.email) record.addedByEmail = identity.email;

    const path = `truth_reference/swd_catalog/${safeKey}`;
    await admin.database().ref(path).set(record);

    return {
      ok: true,
      record,
      path,
    };
  }
);

// ─────────────────────────────────────────────────────────────────────────
// Phase 22 — deactivate + list paths
// ─────────────────────────────────────────────────────────────────────────

interface RawDeactivateRequest {
  name?: string;
}

interface ParsedDeactivateRequest {
  rawName: string;
  safeKey: string;
}

function parseDeactivateRequest(data: unknown): ParsedDeactivateRequest {
  const req = (data ?? {}) as RawDeactivateRequest;
  const rawName =
    typeof req.name === 'string' ? req.name.trim() : '';
  if (!rawName) {
    throw new HttpsError('invalid-argument', 'Missing required `name`.');
  }
  const normalizedName = normalizeLocationNameForOfficialMatch(rawName);
  if (!normalizedName) {
    throw new HttpsError(
      'invalid-argument',
      '`name` normalizes to empty.'
    );
  }
  return {
    rawName,
    safeKey: normalizedSwdNameToSafeKey(normalizedName),
  };
}

/**
 * Phase 22 — deactivate a single runtime SWD reference entry.
 *
 * Admin-gated. Soft-delete: reads the record at
 *   truth_reference/swd_catalog/{safeKey}
 * and partial-updates `active: false` + `deactivatedAt` + `deactivatedByUid`
 * + `deactivatedByEmail?`. Original `name`, `normalizedName`, `addedAt`,
 * `addedBy*`, `type` are preserved for audit.
 *
 * Idempotent:
 *   - missing record   -> { ok: true, alreadyInactive: true,
 *                           note: 'no entry found' }
 *   - already inactive -> re-stamps the deactivate audit fields (refresh
 *                         who-last-touched-it), returns `alreadyInactive: true`
 *   - active record    -> flips active to false, stamps deactivate fields
 *
 * Next shadow read: `loadSwdReferenceRuntime` filters `active === false`,
 * so the deactivated entry drops out of the SWD match set automatically.
 * Static seed entries in shared/truth-layer/data/swdReference.ts are NOT
 * affected — they're code-deployed, not in this RTDB catalog.
 *
 * Hard-delete is NOT supported. Every deactivation stays in RTDB with
 * full audit trail so we can see who added → who deactivated → when.
 */
export const deactivateTruthSwdReference = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const identity = await requireAdminRole(request);
    const { safeKey } = parseDeactivateRequest(request.data);

    const path = `truth_reference/swd_catalog/${safeKey}`;
    const ref = admin.database().ref(path);

    const snap = await ref.once('value');
    if (!snap.exists()) {
      return {
        ok: true,
        alreadyInactive: true,
        path,
        note: 'no entry found',
      };
    }

    const deactivatedAt = new Date().toISOString();
    const patch: {
      active: false;
      deactivatedAt: string;
      deactivatedByUid: string;
      deactivatedByEmail?: string;
    } = {
      active: false,
      deactivatedAt,
      deactivatedByUid: identity.uid,
    };
    if (identity.email) patch.deactivatedByEmail = identity.email;

    await ref.update(patch);

    const afterSnap = await ref.once('value');
    return {
      ok: true,
      alreadyInactive: snap.val()?.active === false,
      record: afterSnap.val(),
      path,
    };
  }
);

/**
 * Phase 22 — list all runtime SWD catalog entries (active + inactive).
 *
 * Admin-gated. Read-only. Returns entries split into `active` and
 * `inactive` arrays, each sorted alphabetically by `name` via
 * `localeCompare` for deterministic ordering across shadow reads.
 *
 * Static seed entries are NOT included — they're code-deployed and
 * should not look mutable from the management UI (per spec §5). This
 * keeps the Phase 22 surface focused on entries admins can actually
 * deactivate.
 *
 * Shape-validates each RTDB record; ignores malformed entries silently.
 * A missing catalog returns zero-length arrays. A read error returns
 * empty arrays + `sourceError` so the UI can surface it.
 */
interface CatalogEntry {
  name: string;
  normalizedName: string;
  addedAt?: string;
  addedByUid?: string;
  addedByEmail?: string;
  deactivatedAt?: string;
  deactivatedByUid?: string;
  deactivatedByEmail?: string;
  active: boolean;
}

function parseCatalogEntry(raw: unknown): CatalogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = r.name;
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  const normalizedName =
    typeof r.normalizedName === 'string' && r.normalizedName.trim().length > 0
      ? r.normalizedName.trim()
      : normalizeLocationNameForOfficialMatch(name);
  const entry: CatalogEntry = {
    name: name.trim(),
    normalizedName,
    // Treat missing/non-boolean `active` as true — matches loader semantics.
    active: r.active !== false,
  };
  if (typeof r.addedAt === 'string') entry.addedAt = r.addedAt;
  if (typeof r.addedByUid === 'string') entry.addedByUid = r.addedByUid;
  if (typeof r.addedByEmail === 'string') entry.addedByEmail = r.addedByEmail;
  if (typeof r.deactivatedAt === 'string') entry.deactivatedAt = r.deactivatedAt;
  if (typeof r.deactivatedByUid === 'string') {
    entry.deactivatedByUid = r.deactivatedByUid;
  }
  if (typeof r.deactivatedByEmail === 'string') {
    entry.deactivatedByEmail = r.deactivatedByEmail;
  }
  return entry;
}

export const listTruthSwdReference = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    await requireAdminRole(request);

    const path = 'truth_reference/swd_catalog';
    try {
      const snap = await admin.database().ref(path).once('value');
      if (!snap.exists()) {
        return {
          ok: true,
          active: [] as CatalogEntry[],
          inactive: [] as CatalogEntry[],
          counts: { active: 0, inactive: 0, total: 0 },
          path,
        };
      }
      const raw = snap.val();
      if (!raw || typeof raw !== 'object') {
        return {
          ok: true,
          active: [] as CatalogEntry[],
          inactive: [] as CatalogEntry[],
          counts: { active: 0, inactive: 0, total: 0 },
          path,
        };
      }
      const active: CatalogEntry[] = [];
      const inactive: CatalogEntry[] = [];
      for (const value of Object.values(raw as Record<string, unknown>)) {
        const entry = parseCatalogEntry(value);
        if (!entry) continue;
        (entry.active ? active : inactive).push(entry);
      }
      const byName = (a: CatalogEntry, b: CatalogEntry) =>
        a.name.localeCompare(b.name);
      active.sort(byName);
      inactive.sort(byName);
      return {
        ok: true,
        active,
        inactive,
        counts: {
          active: active.length,
          inactive: inactive.length,
          total: active.length + inactive.length,
        },
        path,
      };
    } catch (err) {
      return {
        ok: true,
        active: [] as CatalogEntry[],
        inactive: [] as CatalogEntry[],
        counts: { active: 0, inactive: 0, total: 0 },
        path,
        sourceError: `swd_catalog: ${(err as Error).message}`,
      };
    }
  }
);
