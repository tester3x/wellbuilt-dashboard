/**
 * adminEmergencyMarkWellsDownPreview / adminEmergencyMarkWellsDown.
 *
 * Preview and Apply are separate exports over one handler, so there is no flag
 * a caller can forget: reaching the writing entry point is a deliberate act.
 * Preview performs the identical reads and the identical decisions and writes
 * nothing, so what a reviewer approves is what Apply re-derives.
 *
 * Apply re-reads and re-decides at write time. The Preview is evidence for a
 * human, never an instruction the server trusts — if a driver pulls a well in
 * between, that well is refused, not marked down.
 *
 * See emergencyWellDown.ts for why this exists rather than the edit-packet path.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requirePlatformAdmin } from '../adminAuth';
import { writeSecurityAudit } from '../audit';
import {
  buildEmergencyWellDownPlan,
  decideEmergencyWellDown,
  parseEmergencyWellDownTargets,
  type EmergencyWellDownDecision,
  type EmergencyWellDownObservation,
  type EmergencyWellDownTarget,
} from './emergencyWellDown';

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Latest outgoing response row for a well, or null. */
async function readOutgoing(wellName: string): Promise<EmergencyWellDownObservation['outgoing']> {
  const snap = await admin.database().ref('packets/outgoing')
    .orderByChild('wellName').equalTo(wellName).once('value');
  if (!snap.exists()) return null;
  let best: EmergencyWellDownObservation['outgoing'] = null;
  snap.forEach((child) => {
    const key = child.key || '';
    if (!key.startsWith('response_') || key.includes('delete')) return;
    const v = asRecord(child.val());
    const row = {
      responseId: key,
      wellName: typeof v.wellName === 'string' ? v.wellName : undefined,
      wellDown: v.wellDown === true,
      isDown: v.isDown === true,
      lastPullDateTimeUTC: typeof v.lastPullDateTimeUTC === 'string' ? v.lastPullDateTimeUTC : undefined,
      lastPullBottomLevel: typeof v.lastPullBottomLevel === 'string' ? v.lastPullBottomLevel : undefined,
      currentLevel: typeof v.currentLevel === 'string' ? v.currentLevel : undefined,
    };
    // processIncomingPull keeps one row per well, but prefer the newest pull if
    // a stale sibling ever survives — marking down off the older one would pin
    // the boundary to the wrong pull.
    if (!best || String(row.lastPullDateTimeUTC ?? '') > String(best.lastPullDateTimeUTC ?? '')) {
      best = row;
    }
  });
  return best;
}

async function observe(wellName: string): Promise<EmergencyWellDownObservation> {
  const db = admin.database();
  const [outgoing, statusSnap, configSnap] = await Promise.all([
    readOutgoing(wellName),
    db.ref(`wells/${wellName}/status/isDown`).once('value'),
    db.ref(`well_config/${wellName}`).once('value'),
  ]);
  const config = asRecord(configSnap.val());
  return {
    outgoing,
    statusIsDown: statusSnap.val() === true,
    config: {
      companyId: typeof config.companyId === 'string' ? config.companyId : undefined,
      avgFlowRate: typeof config.avgFlowRate === 'string' ? config.avgFlowRate : undefined,
      avgFlowRateMinutes:
        typeof config.avgFlowRateMinutes === 'number' ? config.avgFlowRateMinutes : undefined,
    },
  };
}

async function handle(request: { auth?: { uid?: string; token?: unknown } | null; data?: unknown },
  opts: { dryRun: boolean }) {
  const caller = await requirePlatformAdmin(
    request.auth?.uid,
    request.auth?.token as Record<string, unknown> | undefined,
  );

  const data = asRecord(request.data);
  const reason = typeof data.reason === 'string' ? data.reason.slice(0, 500) : '';
  if (!opts.dryRun && !reason.trim()) {
    // A write with no stated reason leaves an audit row nobody can interpret.
    throw new httpsV2.HttpsError('invalid-argument', 'reason_required');
  }

  let targets: EmergencyWellDownTarget[];
  try {
    targets = parseEmergencyWellDownTargets(data.targets);
  } catch (err) {
    throw new httpsV2.HttpsError('invalid-argument', (err as Error).message);
  }

  const decisions: EmergencyWellDownDecision[] = [];
  for (const target of targets) {
    decisions.push(decideEmergencyWellDown(target, await observe(target.wellName)));
  }
  const plan = buildEmergencyWellDownPlan(decisions, opts.dryRun);

  if (opts.dryRun) {
    await writeSecurityAudit({
      action: 'adminEmergencyMarkWellsDown_preview',
      actorUid: caller.uid,
      detail: { counts: plan.counts, wells: targets.map((t) => t.wellName), reason },
    });
    return plan;
  }

  // Two boolean flips per well. Nothing else is written, and a well that was
  // refused above contributes no path at all.
  const updates: Record<string, unknown> = {};
  for (const d of decisions) {
    if (d.action !== 'mark_down') continue;
    for (const path of d.willWrite) updates[path] = true;
  }
  if (Object.keys(updates).length > 0) {
    await admin.database().ref().update(updates);
  }

  await writeSecurityAudit({
    action: 'adminEmergencyMarkWellsDown_apply',
    actorUid: caller.uid,
    detail: {
      counts: plan.counts,
      reason,
      wrote: Object.keys(updates),
      refused: decisions.filter((d) => d.action.startsWith('refuse')).map((d) => ({
        wellName: d.wellName, reason: d.reason,
      })),
    },
  });
  return plan;
}

const OPTIONS = { timeoutSeconds: 120, memory: '256MiB' as const, enforceAppCheck: false };

/** Read-only. Performs every read and decision Apply would, and writes nothing. */
export const adminEmergencyMarkWellsDownPreview = httpsV2.onCall(
  OPTIONS,
  async (request) => handle(request, { dryRun: true }),
);

/** Writes isDown/wellDown only, for wells whose stated evidence still holds. */
export const adminEmergencyMarkWellsDown = httpsV2.onCall(
  OPTIONS,
  async (request) => handle(request, { dryRun: false }),
);
