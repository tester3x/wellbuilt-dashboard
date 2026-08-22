/**
 * adminPreviewEstimationHold / adminApplyEstimationHold.
 *
 * Preview evaluates the COMPLETE well pool server-side. It is not given a list
 * to rubber-stamp: it reads every well in well_config, reads that well's
 * accepted production-pull history, computes the well's own average pull
 * interval from the real gaps between pulls, and proposes a hold when the time
 * since the latest accepted pull exceeds that average. No flow rate is
 * required; no well is pre-filtered away. Wells that are physically down, or
 * too thinly evidenced to average, are reported with that outcome rather than
 * dropped — "not proposed" and "not examined" must not look the same.
 *
 * Preview performs reads only: no security_audit document, no application
 * database write of any kind.
 *
 * Apply re-reads, recomputes the whole calculation at the Preview's asOf, and
 * refuses the entire batch unless the digest still matches. Each hold is then
 * taken by compare-and-set against the exact hold state Preview observed, so a
 * newer or different hold is never overwritten. If any well aborts, the holds
 * this operation wrote are rolled back by applyOpId ownership, so a batch is
 * all-or-nothing rather than half-applied.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { createHash, randomUUID } from 'node:crypto';
import { requirePlatformAdmin } from '../adminAuth';
import { writeSecurityAudit } from '../audit';
import {
  buildHoldPlan,
  decideEstimationHold,
  holdCompareAndSet,
  holdCompensate,
  HOLD_REASON_MAX,
  type EstimationHoldRecord,
  type HoldDecision,
  type HoldObservation,
} from './emergencyEstimationHold';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** How stale a Preview may be before Apply refuses it outright. */
export const PREVIEW_MAX_AGE_MS = 30 * 60 * 1000;

interface PoolSnapshot {
  wellNames: string[];
  observations: Map<string, HoldObservation>;
}

/**
 * One pass over the pool.
 *
 * packets/processed is read whole and grouped in memory rather than queried per
 * well: the pool is ~80 wells and a per-well query each would be ~80 round
 * trips for data we need in full anyway.
 */
async function readPool(): Promise<PoolSnapshot> {
  const db = admin.database();
  const [configSnap, outgoingSnap, wellsSnap, processedSnap] = await Promise.all([
    db.ref('well_config').once('value'),
    db.ref('packets/outgoing').once('value'),
    db.ref('wells').once('value'),
    db.ref('packets/processed').once('value'),
  ]);

  const configs = asRecord(configSnap.val());
  const wellsNode = asRecord(wellsSnap.val());

  // Latest outgoing row per well.
  const outgoing = new Map<string, HoldObservation['outgoing']>();
  const outgoingRaw = asRecord(outgoingSnap.val());
  for (const [key, val] of Object.entries(outgoingRaw)) {
    if (!key.startsWith('response_') || key.includes('delete')) continue;
    const v = asRecord(val);
    const wellName = typeof v.wellName === 'string' ? v.wellName : '';
    if (!wellName) continue;
    const row = {
      responseId: key,
      lastPullDateTimeUTC: typeof v.lastPullDateTimeUTC === 'string' ? v.lastPullDateTimeUTC : undefined,
      lastPullBottomLevel: typeof v.lastPullBottomLevel === 'string' ? v.lastPullBottomLevel : undefined,
      currentLevel: typeof v.currentLevel === 'string' ? v.currentLevel : undefined,
      wellDown: v.wellDown === true,
      isDown: v.isDown === true,
    };
    const prev = outgoing.get(wellName);
    if (!prev || String(row.lastPullDateTimeUTC ?? '') > String(prev.lastPullDateTimeUTC ?? '')) {
      outgoing.set(wellName, row);
    }
  }

  // Accepted production pulls per well. An edit/delete request is not a pull,
  // and a no-level service packet carries no tank reading — neither belongs in
  // a cadence average.
  const pulls = new Map<string, number[]>();
  const processedRaw = asRecord(processedSnap.val());
  for (const val of Object.values(processedRaw)) {
    const v = asRecord(val);
    const wellName = typeof v.wellName === 'string' ? v.wellName : '';
    if (!wellName) continue;
    const reqType = typeof v.requestType === 'string' ? v.requestType : 'pull';
    if (reqType !== 'pull') continue;
    if (v.noLevel === true) continue;
    const ts = typeof v.dateTimeUTC === 'string' ? Date.parse(v.dateTimeUTC) : NaN;
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const list = pulls.get(wellName);
    if (list) list.push(ts); else pulls.set(wellName, [ts]);
  }

  // The pool is well_config. Include any well that only has status/history so a
  // well missing from config is still surfaced rather than silently unexamined.
  const wellNames = Array.from(new Set([
    ...Object.keys(configs),
    ...outgoing.keys(),
    ...pulls.keys(),
  ])).sort();

  const observations = new Map<string, HoldObservation>();
  for (const wellName of wellNames) {
    const cfg = asRecord(configs[wellName]);
    const wellNode = asRecord(wellsNode[wellName]);
    const holdRaw = asRecord(wellNode.estimationHold);
    observations.set(wellName, {
      outgoing: outgoing.get(wellName) ?? null,
      statusIsDown: asRecord(wellNode.status).isDown === true,
      hold: Object.keys(holdRaw).length ? (holdRaw as Partial<EstimationHoldRecord>) : null,
      acceptedPullMs: pulls.get(wellName) ?? [],
      config: {
        companyId: typeof cfg.companyId === 'string' ? cfg.companyId : undefined,
        avgFlowRate: typeof cfg.avgFlowRate === 'string' ? cfg.avgFlowRate : undefined,
        avgFlowRateMinutes: typeof cfg.avgFlowRateMinutes === 'number' ? cfg.avgFlowRateMinutes : undefined,
      },
    });
  }
  return { wellNames, observations };
}

function decidePool(pool: PoolSnapshot, asOfMs: number): HoldDecision[] {
  return pool.wellNames.map((wellName) => decideEstimationHold({
    wellName, asOfMs, observed: pool.observations.get(wellName)!,
  }));
}

const OPTIONS = { timeoutSeconds: 540, memory: '512MiB' as const, enforceAppCheck: false };

/**
 * READ-ONLY. Evaluates every well and returns the plan plus the digest Apply
 * requires. Writes nothing — platform log only.
 */
export const adminPreviewEstimationHold = httpsV2.onCall(OPTIONS, async (request) => {
  const caller = await requirePlatformAdmin(
    request.auth?.uid,
    request.auth?.token as Record<string, unknown> | undefined,
  );
  const asOfMs = Date.now();
  const pool = await readPool();
  const plan = buildHoldPlan({
    decisions: decidePool(pool, asOfMs), dryRun: true, callerUid: caller.uid, asOfMs, digest: sha256,
  });
  console.log(
    `[estimationHold] preview uid=${caller.uid} pool=${pool.wellNames.length} ` +
    `propose=${plan.willWriteCount} asOf=${plan.asOfUTC} digest=${plan.previewDigest.slice(0, 12)}`,
  );
  return plan;
});

/** Takes holds. Digest-gated, compare-and-set per well, all-or-nothing. */
export const adminApplyEstimationHold = httpsV2.onCall(OPTIONS, async (request) => {
  const caller = await requirePlatformAdmin(
    request.auth?.uid,
    request.auth?.token as Record<string, unknown> | undefined,
  );
  const data = asRecord(request.data);

  const reason = typeof data.reason === 'string' ? data.reason.slice(0, HOLD_REASON_MAX) : '';
  if (!reason.trim()) throw new httpsV2.HttpsError('invalid-argument', 'reason_required');

  const previewDigest = data.previewDigest;
  if (typeof previewDigest !== 'string' || previewDigest.length !== 64) {
    throw new httpsV2.HttpsError('invalid-argument', 'preview_digest_required');
  }
  const asOfMs = typeof data.asOfMs === 'number' && Number.isFinite(data.asOfMs) ? data.asOfMs : 0;
  if (asOfMs <= 0) throw new httpsV2.HttpsError('invalid-argument', 'asOfMs_required');
  if (Date.now() - asOfMs > PREVIEW_MAX_AGE_MS) {
    throw new httpsV2.HttpsError('failed-precondition', 'preview_expired: re-run preview');
  }

  // Re-read and recompute the entire calculation at the Preview's asOf. The
  // Preview is a human artifact; nothing about it is trusted as input.
  const pool = await readPool();
  const plan = buildHoldPlan({
    decisions: decidePool(pool, asOfMs), dryRun: false, callerUid: caller.uid, asOfMs, digest: sha256,
  });

  if (plan.previewDigest !== previewDigest) {
    throw new httpsV2.HttpsError(
      'failed-precondition',
      'preview_digest_mismatch: pool state changed since preview; re-run preview',
    );
  }

  const applyOpId = randomUUID();
  const db = admin.database();
  const wrote: string[] = [];
  const aborted: string[] = [];

  for (const d of plan.decisions) {
    if (d.action !== 'apply_hold') continue;
    const heldAtPullUTC = d.observed.lastPullDateTimeUTC;
    if (!heldAtPullUTC) continue;
    const next: EstimationHoldRecord = {
      active: true,
      heldAtPullUTC,
      ...(d.observed.responseId ? { heldAtResponseId: d.observed.responseId } : {}),
      heldByUid: caller.uid,
      heldAtMs: Date.now(),
      applyOpId,
      reason,
    };
    const tx = await db.ref(`wells/${d.wellName}/estimationHold`).transaction((current) =>
      holdCompareAndSet(current as Partial<EstimationHoldRecord> | null, d.observed.holdFingerprint, next));
    if (tx.committed) wrote.push(d.wellName); else aborted.push(d.wellName);
  }

  // All-or-nothing. A half-applied batch is a set of holds nobody reviewed as a
  // set, so if any well drifted we undo only what this operation wrote.
  let rolledBack: string[] = [];
  if (aborted.length > 0 && wrote.length > 0) {
    for (const wellName of wrote) {
      const tx = await db.ref(`wells/${wellName}/estimationHold`).transaction((current) =>
        holdCompensate(current as Partial<EstimationHoldRecord> | null, applyOpId));
      if (tx.committed) rolledBack.push(wellName);
    }
  }

  const applied = aborted.length > 0 ? [] : wrote;

  await writeSecurityAudit({
    action: 'adminApplyEstimationHold',
    actorUid: caller.uid,
    detail: {
      reason, previewDigest, applyOpId, asOfMs,
      counts: plan.counts, applied, aborted, rolledBack,
      poolSize: pool.wellNames.length,
    },
  });

  if (aborted.length > 0) {
    throw new httpsV2.HttpsError(
      'aborted',
      `hold_cas_conflict: ${aborted.join(', ')} changed during apply; ` +
      `${rolledBack.length} rolled back, nothing applied`,
    );
  }

  return { ...plan, applyOpId, applied, aborted, rolledBack };
});
