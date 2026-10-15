import * as admin from 'firebase-admin';
import * as https from 'firebase-functions/v2/https';
import { DEMO_COMPANY_ID } from './runtime';
import { demoProjectedInches, demoPullPlan, demoTriggerInches, demoWellClock } from './wellClock';

const VIEWER_UID = 'wellbuilt-demo-shared-viewer';

/** Read-only measurement plan for the dedicated Android demo driver. */
export const demoWellPullPlan = https.onCall(
  { timeoutSeconds: 15, memory: '256MiB', enforceAppCheck: false },
  async request => {
    if (request.auth?.uid !== VIEWER_UID
      || request.auth.token.staffCompanyId !== DEMO_COMPANY_ID
      || request.auth.token.staffRole !== 'demo_viewer'
      || request.auth.token.isDemo !== true) {
      throw new https.HttpsError('permission-denied', 'demo_viewer_required');
    }
    const wellName = typeof request.data?.wellName === 'string' ? request.data.wellName : '';
    if (!/^Demo Well [1-3]$/.test(wellName)) {
      throw new https.HttpsError('invalid-argument', 'demo_well_required');
    }
    const db = admin.database();
    const [configSnap, outgoingSnap] = await Promise.all([
      db.ref(`well_config/${wellName}`).once('value'),
      db.ref('packets/outgoing').orderByChild('wellName').equalTo(wellName).limitToLast(1).once('value'),
    ]);
    const config = configSnap.val() as Record<string, unknown> | null;
    const clock = config && demoWellClock(config);
    if (!clock) throw new https.HttpsError('failed-precondition', 'demo_well_clock_unavailable');
    let outgoing: Record<string, unknown> | null = null;
    outgoingSnap.forEach(child => { outgoing = child.val(); });
    if (outgoing && outgoing['companyId'] !== DEMO_COMPANY_ID) {
      throw new https.HttpsError('failed-precondition', 'demo_well_status_mismatch');
    }
    const bottomMatch = outgoing
      ? /^(\d+)'(\d+)"$/.exec(String(outgoing['lastPullBottomLevel'] || '')) : null;
    const bottomInches = outgoing
      ? (bottomMatch ? Number(bottomMatch[1]) * 12 + Number(bottomMatch[2]) : NaN)
      : Number(config['demoInitialLevelInches']);
    const pullTimeMs = Date.parse(String(outgoing
      ? outgoing['lastPullDateTimeUTC'] : config['demoInitialAsOfUTC'] || ''));
    if (!Number.isFinite(bottomInches) || bottomInches < clock.bottomInches
      || !Number.isFinite(pullTimeMs) || pullTimeMs > Date.now() + 60_000) {
      throw new https.HttpsError('failed-precondition', 'demo_well_needs_reset');
    }
    const lastPacketId = String(outgoing?.['lastPullPacketId'] || wellName);
    const triggerInches = outgoing
      ? demoTriggerInches(clock, lastPacketId)
      : Number(config['demoInitialTriggerInches']);
    if (!Number.isInteger(triggerInches)
      || triggerInches < clock.minimumTriggerInches
      || triggerInches > clock.maximumTriggerInches) {
      throw new https.HttpsError('failed-precondition', 'demo_trigger_unavailable');
    }
    const levelInches = demoProjectedInches(clock, bottomInches, pullTimeMs, Date.now(), triggerInches);
    const plan = demoPullPlan(clock, levelInches, triggerInches);
    return {
      companyId: DEMO_COMPANY_ID, wellName, ready: plan.ready,
      topInches: plan.topInches, topFeet: plan.topInches / 12,
      bbls: plan.bbls, bottomInches: plan.bottomInches,
      allowedBottomInches: clock.bottomInches, triggerInches,
      realMinutesPerFoot: clock.realMinutesPerFoot,
      clockMultiplier: clock.clockMultiplier,
    };
  },
);
