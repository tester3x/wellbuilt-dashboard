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
