/**
 * JSA mode + per-job policy canonicalization (vc51.4, 8/6).
 *
 * Mirrors WB-T's utils/jsaRules.ts EXACTLY — the Dashboard writes what the
 * apps read, so the mapping must be byte-for-byte the same contract:
 *
 *   jsaMode      — FREQUENCY: off | per_shift | per_job
 *                  (legacy per_load / per_location read as per_job; the
 *                  settings form normalizes them only on a deliberate save)
 *   jsaJobPolicy — HOW a per_job requirement is satisfied:
 *                  acknowledge | read | read_and_acknowledge.
 *                  Absent/malformed falls back to the legacy
 *                  jsaAllowAcknowledge toggle so every existing company
 *                  keeps today's effective behavior until explicitly saved:
 *                    !== false → 'acknowledge'   (shortcut era default)
 *                    === false → 'read'          (read-only enforcement)
 *
 * jsaAllowAcknowledge remains meaningful ONLY for the per-shift close
 * shortcut; an explicit jsaJobPolicy always wins for per-job behavior
 * (both here and in the apps), so a stale hidden toggle can never
 * contradict the chosen policy.
 *
 * Pure + node-testable; no imports.
 */

export type JsaMode = 'off' | 'per_shift' | 'per_job';
export type JsaJobPolicy = 'acknowledge' | 'read' | 'read_and_acknowledge';

export function canonicalizeJsaMode(mode: string | undefined): JsaMode {
  if (mode === 'per_load' || mode === 'per_location') return 'per_job';
  if (mode === 'off' || mode === 'per_shift' || mode === 'per_job') return mode;
  return 'off';
}

/** True when the STORED value is a legacy alias the form should normalize
 *  on the next deliberate mode save. */
export function isLegacyJsaMode(mode: string | undefined): boolean {
  return mode === 'per_load' || mode === 'per_location';
}

export function canonicalizeJsaJobPolicy(
  policy: unknown,
  rawAllowAcknowledge: unknown,
): JsaJobPolicy {
  if (policy === 'acknowledge' || policy === 'read' || policy === 'read_and_acknowledge') {
    return policy;
  }
  return rawAllowAcknowledge === false ? 'read' : 'acknowledge';
}

/** Customer-facing options — honest scope: what the driver does and what
 *  is recorded; no claims of comprehension, cryptographic content
 *  attestation, or tamper-proofing against a malicious client. */
export const JSA_JOB_POLICIES: ReadonlyArray<{
  value: JsaJobPolicy;
  label: string;
  desc: string;
}> = [
  {
    value: 'acknowledge',
    label: 'Acknowledge each job',
    desc: 'The first applicable job in each shift or configured work period requires the driver to read and complete the full JSA. Each additional applicable job in that same period can be acknowledged with Start Job.',
  },
  {
    value: 'read',
    label: 'Read each job',
    desc: 'Driver must complete the full JSA flow for every job. No acknowledgement shortcut is available.',
  },
  {
    value: 'read_and_acknowledge',
    label: 'Read, then acknowledge',
    desc: 'Driver completes the full JSA flow, then reviews what that specific job adds and confirms with Start Job.',
  },
];
