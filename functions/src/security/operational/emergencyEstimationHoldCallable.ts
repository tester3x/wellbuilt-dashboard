/**
 * adminPreviewEstimationHold / adminApplyEstimationHold.
 *
 * Preview evaluates the COMPLETE well pool server-side — it is not given a list
 * to rubber-stamp. Every well is resolved to one canonical identity across
 * well_config, packets/outgoing, packets/processed, wells/{w}/status and the
 * hold root, so a legacy "Gabriel1" row cannot separate a well's history from
 * its physical state. Configured names that collapse onto the same identity are
 * refused rather than merged.
 *
 * Preview writes nothing: no security_audit document, no application database
 * write of any kind. Platform log only.
 *
 * Apply re-reads, recomputes the whole calculation at the Preview's asOf,
 * refuses the batch unless the digest still reproduces, and then takes every
 * hold in ONE transaction over the hold root — all of them or none, with no
 * compensation pass that could itself fail.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { createHash, randomUUID } from 'node:crypto';
import { requirePlatformAdmin } from '../adminAuth';
import { writeSecurityAudit } from '../audit';
import {
  ambiguousIdentityDecision,
  buildHoldPlan,
  canonicalWellKey,
  collectAcceptedPulls,
  decideEstimationHold,
  holdBatchCompareAndSet,
  resolveWellIdentity,
  HOLD_REASON_MAX,
  HOLD_ROOT,
  type EstimationHoldRecord,
  type HoldBatchEntry,
  type HoldDecision,
  type HoldObservation,
  type PullRejectReason,
} from './emergencyEstimationHold';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export const PREVIEW_MAX_AGE_MS = 30 * 60 * 1000;

interface PoolSnapshot {
  decisionsInput: Array<{ wellKey: string; wellName: string; observed: HoldObservation }>;
  collisions: Map<string, string[]>;
  rejected: Record<PullRejectReason, number>;
}

/**
 * One pass over the pool, joined on canonical identity.
 *
 * packets/processed is read whole and grouped in memory rather than queried per
 * well: the pool is ~80 wells and the classification needs every record's key
 * anyway, which a per-well query would not simplify.
 */
async function readPool(): Promise<PoolSnapshot> {
  const db = admin.database();
  const [configSnap, outgoingSnap, wellsSnap, processedSnap, holdSnap] = await Promise.all([
    db.ref('well_config').once('value'),
    db.ref('packets/outgoing').once('value'),
    db.ref('wells').once('value'),
    db.ref('packets/processed').once('value'),
    db.ref(HOLD_ROOT).once('value'),
  ]);

  const configs = asRecord(configSnap.val());
  const wellsNode = asRecord(wellsSnap.val());
  const holds = asRecord(holdSnap.val());

  // Accepted pulls, classified with their KEYS — edit_*/delete_* records carry
  // no requestType and would otherwise be counted as production pulls.
  const processedRaw = asRecord(processedSnap.val());
  const { byWellKey: pullsByKey, rejected } = collectAcceptedPulls(
    Object.entries(processedRaw).map(([key, value]) => ({ key, value })),
  );

  // Latest outgoing row per canonical well.
  const outgoingByKey = new Map<string, HoldObservation['outgoing']>();
  const outgoingNames: string[] = [];
  for (const [key, val] of Object.entries(asRecord(outgoingSnap.val()))) {
    if (!key.startsWith('response_') || key.includes('delete')) continue;
    const v = asRecord(val);
    const wellName = typeof v.wellName === 'string' ? v.wellName.trim() : '';
    if (!wellName) continue;
    outgoingNames.push(wellName);
    const wellKey = canonicalWellKey(wellName);
    const row = {
      responseId: key,
      lastPullDateTimeUTC: typeof v.lastPullDateTimeUTC === 'string' ? v.lastPullDateTimeUTC : undefined,
      lastPullBottomLevel: typeof v.lastPullBottomLevel === 'string' ? v.lastPullBottomLevel : undefined,
      currentLevel: typeof v.currentLevel === 'string' ? v.currentLevel : undefined,
      wellDown: v.wellDown === true,
      isDown: v.isDown === true,
    };
    const prev = outgoingByKey.get(wellKey);
    if (!prev || String(row.lastPullDateTimeUTC ?? '') > String(prev.lastPullDateTimeUTC ?? '')) {
      outgoingByKey.set(wellKey, row);
    }
  }

  // Physical state, joined on the same key.
  const statusDownByKey = new Map<string, boolean>();
  const wellsNames: string[] = [];
  for (const [name, node] of Object.entries(wellsNode)) {
    wellsNames.push(name);
    const key = canonicalWellKey(name);
    if (asRecord(asRecord(node).status).isDown === true) statusDownByKey.set(key, true);
  }

  const identity = resolveWellIdentity({
    configNames: Object.keys(configs),
    otherNames: [...outgoingNames, ...wellsNames],
  });
  // A well known only from history still deserves a row.
  for (const key of pullsByKey.keys()) {
    if (!identity.canonicalName.has(key) && !identity.collisions.has(key)) {
      identity.canonicalName.set(key, key);
    }
  }

  const configByKey = new Map<string, Record<string, unknown>>();
  for (const [name, cfg] of Object.entries(configs)) configByKey.set(canonicalWellKey(name), asRecord(cfg));

  const decisionsInput = Array.from(identity.canonicalName.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([wellKey, wellName]) => {
      const cfg = configByKey.get(wellKey) ?? {};
      // Raw, uncoerced: the fingerprint covers the whole stored value, so
      // normalising it here would hide exactly the drift it exists to catch.
      const holdRaw = holds[wellKey];
      return {
        wellKey,
        wellName,
        observed: {
          outgoing: outgoingByKey.get(wellKey) ?? null,
          statusIsDown: statusDownByKey.get(wellKey) === true,
          hold: holdRaw,
          acceptedPullMs: pullsByKey.get(wellKey) ?? [],
          config: {
            companyId: typeof cfg.companyId === 'string' ? cfg.companyId : undefined,
            avgFlowRate: typeof cfg.avgFlowRate === 'string' ? cfg.avgFlowRate : undefined,
            avgFlowRateMinutes:
              typeof cfg.avgFlowRateMinutes === 'number' ? cfg.avgFlowRateMinutes : undefined,
          },
        } as HoldObservation,
      };
    });

  return { decisionsInput, collisions: identity.collisions, rejected };
}

function decidePool(pool: PoolSnapshot, asOfMs: number): HoldDecision[] {
  const decided = pool.decisionsInput.map((d) => decideEstimationHold({ ...d, asOfMs }));
  const ambiguous = Array.from(pool.collisions.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, names]) => ambiguousIdentityDecision(key, names));
  return [...decided, ...ambiguous].sort((a, b) => a.wellKey.localeCompare(b.wellKey));
}

const OPTIONS = { timeoutSeconds: 540, memory: '512MiB' as const, enforceAppCheck: false };

/** READ-ONLY. Evaluates every well; writes nothing. */
export const adminPreviewEstimationHold = httpsV2.onCall(OPTIONS, async (request) => {
  const caller = await requirePlatformAdmin(
    request.auth?.uid,
    request.auth?.token as Record<string, unknown> | undefined,
  );
  const asOfMs = Date.now();
  const pool = await readPool();
  const plan = buildHoldPlan({
    decisions: decidePool(pool, asOfMs), dryRun: true, callerUid: caller.uid,
    asOfMs, digest: sha256, rejectedRecords: pool.rejected,
  });
  console.log(
    `[estimationHold] preview uid=${caller.uid} pool=${plan.poolSize} propose=${plan.willWriteCount} ` +
    `ambiguous=${plan.counts.refuse_ambiguous_identity} asOf=${plan.asOfUTC} ` +
    `digest=${plan.previewDigest.slice(0, 12)}`,
  );
  return plan;
});

/** Takes holds. Digest-gated, single atomic transaction, all-or-nothing. */
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

  const pool = await readPool();
  const plan = buildHoldPlan({
    decisions: decidePool(pool, asOfMs), dryRun: false, callerUid: caller.uid,
    asOfMs, digest: sha256, rejectedRecords: pool.rejected,
  });
  if (plan.previewDigest !== previewDigest) {
    throw new httpsV2.HttpsError(
      'failed-precondition',
      'preview_digest_mismatch: pool state changed since preview; re-run preview',
    );
  }

  const applyOpId = randomUUID();
  const heldAtMs = Date.now();
  const entries: HoldBatchEntry[] = plan.decisions
    .filter((d) => d.action === 'apply_hold' && d.observed.lastPullDateTimeUTC)
    .map((d) => ({
      wellKey: d.wellKey,
      expectedFingerprint: d.observed.holdFingerprint,
      record: {
        active: true,
        wellName: d.wellName,
        heldAtPullUTC: d.observed.lastPullDateTimeUTC as string,
        ...(d.observed.responseId ? { heldAtResponseId: d.observed.responseId } : {}),
        heldByUid: caller.uid,
        heldAtMs,
        applyOpId,
        reason,
      } as EstimationHoldRecord,
    }));

  let conflicts: string[] = [];
  let committed = false;
  if (entries.length > 0) {
    // ONE transaction over the whole hold root. Every expected fingerprint is
    // verified inside it; a single conflict aborts before anything is written,
    // so there is no partial state to compensate for and no window in between.
    const tx = await admin.database().ref(HOLD_ROOT).transaction((current) => {
      const outcome = holdBatchCompareAndSet(current as Record<string, unknown> | null, entries);
      if (!outcome.committed) { conflicts = outcome.conflicts; return undefined; }
      return outcome.root;
    });
    committed = tx.committed;
  } else {
    committed = true; // nothing proposed — vacuously applied
  }

  const applied = committed ? entries.map((e) => e.wellKey) : [];

  await writeSecurityAudit({
    action: 'adminApplyEstimationHold',
    actorUid: caller.uid,
    detail: {
      reason, previewDigest, applyOpId, asOfMs,
      counts: plan.counts, poolSize: plan.poolSize,
      proposed: entries.map((e) => e.wellKey), applied,
      committed, conflicts,
    },
  });

  if (!committed) {
    // Nothing was written — provable, because the transaction aborted before
    // any mutation rather than after some of it.
    throw new httpsV2.HttpsError(
      'aborted',
      `hold_batch_conflict: ${conflicts.join(', ') || 'contention'} changed during apply; ` +
      'nothing was written — re-run preview',
    );
  }

  return { ...plan, applyOpId, applied, conflicts: [] };
});
