/**
 * adminPreviewEstimationHold / adminApplyEstimationHold.
 *
 * Preview performs reads only. No security_audit document, no application
 * database write of any kind — a review step that mutates is not a review step.
 * It emits a platform log line and returns the plan plus a digest.
 *
 * Apply requires that digest. It re-reads everything, recomputes the digest from
 * live state, and refuses the whole batch on any difference — so an approval
 * cannot be replayed against a world that has moved on. Each well is then taken
 * with its own transaction, and a hold is bound to the pull it was taken
 * against, so even a pull landing mid-Apply cannot leave a live well suppressed.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { createHash } from 'node:crypto';
import { requirePlatformAdmin } from '../adminAuth';
import { writeSecurityAudit } from '../audit';
import {
  buildHoldPlan,
  decideEstimationHold,
  holdTransactionUpdate,
  parseHoldTargets,
  HOLD_REASON_MAX,
  type EstimationHoldRecord,
  type HoldDecision,
  type HoldObservation,
  type HoldTarget,
} from './emergencyEstimationHold';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

async function readOutgoing(wellName: string): Promise<HoldObservation['outgoing']> {
  const snap = await admin.database().ref('packets/outgoing')
    .orderByChild('wellName').equalTo(wellName).once('value');
  if (!snap.exists()) return null;
  let best: HoldObservation['outgoing'] = null;
  snap.forEach((child) => {
    const key = child.key || '';
    if (!key.startsWith('response_') || key.includes('delete')) return;
    const v = asRecord(child.val());
    const row = {
      responseId: key,
      lastPullDateTimeUTC: typeof v.lastPullDateTimeUTC === 'string' ? v.lastPullDateTimeUTC : undefined,
      lastPullBottomLevel: typeof v.lastPullBottomLevel === 'string' ? v.lastPullBottomLevel : undefined,
      currentLevel: typeof v.currentLevel === 'string' ? v.currentLevel : undefined,
      wellDown: v.wellDown === true,
      isDown: v.isDown === true,
    };
    if (!best || String(row.lastPullDateTimeUTC ?? '') > String(best.lastPullDateTimeUTC ?? '')) best = row;
  });
  return best;
}

async function observe(wellName: string): Promise<HoldObservation> {
  const db = admin.database();
  const [outgoing, statusSnap, holdSnap, configSnap] = await Promise.all([
    readOutgoing(wellName),
    db.ref(`wells/${wellName}/status/isDown`).once('value'),
    db.ref(`wells/${wellName}/estimationHold`).once('value'),
    db.ref(`well_config/${wellName}`).once('value'),
  ]);
  const config = asRecord(configSnap.val());
  return {
    outgoing,
    statusIsDown: statusSnap.val() === true,
    hold: holdSnap.exists() ? (asRecord(holdSnap.val()) as Partial<EstimationHoldRecord>) : null,
    config: {
      companyId: typeof config.companyId === 'string' ? config.companyId : undefined,
      avgFlowRate: typeof config.avgFlowRate === 'string' ? config.avgFlowRate : undefined,
      avgFlowRateMinutes:
        typeof config.avgFlowRateMinutes === 'number' ? config.avgFlowRateMinutes : undefined,
    },
  };
}

async function decideAll(targets: HoldTarget[]): Promise<HoldDecision[]> {
  const out: HoldDecision[] = [];
  for (const t of targets) out.push(decideEstimationHold(t, await observe(t.wellName)));
  return out;
}

function parseTargetsOrThrow(raw: unknown): HoldTarget[] {
  try {
    return parseHoldTargets(raw);
  } catch (err) {
    throw new httpsV2.HttpsError('invalid-argument', (err as Error).message);
  }
}

const OPTIONS = { timeoutSeconds: 300, memory: '256MiB' as const, enforceAppCheck: false };

/**
 * READ-ONLY. Performs the same reads and decisions Apply will, writes nothing,
 * and returns the digest Apply requires.
 */
export const adminPreviewEstimationHold = httpsV2.onCall(OPTIONS, async (request) => {
  const caller = await requirePlatformAdmin(
    request.auth?.uid,
    request.auth?.token as Record<string, unknown> | undefined,
  );
  const targets = parseTargetsOrThrow(asRecord(request.data).targets);
  const decisions = await decideAll(targets);
  const plan = buildHoldPlan(decisions, true, caller.uid, sha256);
  // Platform log only — deliberately no security_audit write on a read path.
  console.log(
    `[estimationHold] preview uid=${caller.uid} wells=${targets.length} ` +
    `willWrite=${plan.willWriteCount} digest=${plan.previewDigest.slice(0, 12)}`,
  );
  return plan;
});

/** Takes holds. Digest-gated, per-well transactional, identity-bound. */
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

  const targets = parseTargetsOrThrow(data.targets);

  // Re-read and re-decide. The Preview is a human artifact, never trusted input.
  const decisions = await decideAll(targets);
  const plan = buildHoldPlan(decisions, false, caller.uid, sha256);

  if (plan.previewDigest !== previewDigest) {
    // Something moved between review and approval. Refuse the batch rather than
    // apply the subset that still matches — a partial apply the reviewer never
    // saw is how a live well gets suppressed.
    throw new httpsV2.HttpsError(
      'failed-precondition',
      'preview_digest_mismatch: state changed since preview; re-run preview',
    );
  }

  const db = admin.database();
  const wrote: string[] = [];
  const aborted: string[] = [];

  for (const d of decisions) {
    if (d.action !== 'apply_hold') continue;
    const heldAtPullUTC = d.observed.lastPullDateTimeUTC;
    if (!heldAtPullUTC) continue;
    const record: EstimationHoldRecord = {
      active: true,
      heldAtPullUTC,
      ...(d.observed.responseId ? { heldAtResponseId: d.observed.responseId } : {}),
      heldByUid: caller.uid,
      heldAtMs: Date.now(),
      reason,
    };
    const ref = db.ref(`wells/${d.wellName}/estimationHold`);
    const tx = await ref.transaction((current) =>
      holdTransactionUpdate(current as Partial<EstimationHoldRecord> | null, record));
    if (tx.committed) wrote.push(`wells/${d.wellName}/estimationHold`);
    else aborted.push(d.wellName);
  }

  await writeSecurityAudit({
    action: 'adminApplyEstimationHold',
    actorUid: caller.uid,
    detail: {
      reason,
      previewDigest,
      counts: plan.counts,
      wrote,
      aborted,
      refused: decisions.filter((d) => d.action.startsWith('refuse')).map((d) => ({
        wellName: d.wellName, reason: d.reason,
      })),
    },
  });

  return { ...plan, wrote, aborted };
});
