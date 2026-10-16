/** A deliberately narrow write path for the shared public demo viewer. */
import * as admin from 'firebase-admin';
import * as https from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { DEMO_COMPANY_ID } from './runtime';
import { loadVerifiedRevision } from '../security/operational/dispatchPinRuntime';
import { resolveCanonicalJobType, stampDispatchBinding } from '../security/operational/dispatchPacketPin';
import { INDEX_COLLECTION } from '../security/operational/jobPacketRevisionStore';
import { packageIndexDocId } from '../security/operational/jobPacketPublish';
import { readDemoWellPullPlan } from './wellPlan';

const VIEWER_UID = 'wellbuilt-demo-shared-viewer';
const DEMO_PHONE_DRIVER_ID = '2f6e6f75-b468-4239-9831-71faeb623acb';
const DEMO_SERVICE_WELLS = new Set(['Demo Service Well 1', 'Demo Service Well 2']);
const MAX_JOBS = 24;
const ACTIVE = new Set(['pending', 'accepted', 'in_progress', 'paused']);
const FINISHED = new Set(['completed', 'cancelled', 'declined']);

export const dispatchDemoViewerJob = https.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    if (request.auth?.uid !== VIEWER_UID
      || request.auth.token.staffCompanyId !== DEMO_COMPANY_ID
      || request.auth.token.staffRole !== 'demo_viewer'
      || request.auth.token.isDemo !== true) {
      throw new https.HttpsError('permission-denied', 'demo_viewer_required');
    }
    const input = request.data || {};
    if (Object.keys(input).some(key => !['wellName', 'disposal', 'driverId', 'loadCount', 'notes', 'jobType', 'serviceType', 'bbls'].includes(key))) {
      throw new https.HttpsError('invalid-argument', 'unsupported_demo_field');
    }
    const serviceJob = input.jobType === 'service';
    if (input.jobType !== undefined && input.jobType !== 'pw' && !serviceJob) {
      throw new https.HttpsError('invalid-argument', 'unsupported_demo_job_type');
    }
    const wellName = typeof input.wellName === 'string' ? input.wellName.trim() : '';
    const disposal = typeof input.disposal === 'string' ? input.disposal.trim() : '';
    const driverId = typeof input.driverId === 'string' ? input.driverId.trim() : '';
    const loadCount = Number(input.loadCount ?? 1);
    const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
    const bbls = Number(input.bbls);
    if (!wellName || !disposal || !/^[0-9a-f-]{36}$/i.test(driverId)
      || !Number.isInteger(loadCount) || loadCount !== 1
      || notes.length > 150
      || (serviceJob && (input.serviceType !== 'Hot Oiler' || wellName === disposal
        || !/^Demo Well [1-3]$/.test(disposal)
        || !DEMO_SERVICE_WELLS.has(wellName)
        || !Number.isInteger(bbls) || bbls < 5 || bbls > 120 || bbls % 5 !== 0))
      || (!serviceJob && (input.serviceType !== undefined || input.bbls !== undefined))) {
      throw new https.HttpsError('invalid-argument', 'invalid_demo_job');
    }

    const fs = admin.firestore();
    const [company, wells, disposalDocs, driver, packetHead] = await Promise.all([
      fs.collection('companies').doc(DEMO_COMPANY_ID).get(),
      admin.database().ref('well_config').once('value'),
      fs.collection('companies').doc(DEMO_COMPANY_ID).collection('swd_directory').get(),
      admin.database().ref(`drivers/profiles/${driverId}`).once('value'),
      fs.collection(INDEX_COLLECTION).doc(packageIndexDocId(DEMO_COMPANY_ID, 'water-hauling')).get(),
    ]);
    if (!company.exists || company.get('isDemo') !== true || company.get('companyId') !== DEMO_COMPANY_ID) {
      throw new https.HttpsError('failed-precondition', 'demo_company_missing');
    }
    const well = Object.values((wells.val() || {}) as Record<string, Record<string, unknown>>)
      .find(value => value.companyId === DEMO_COMPANY_ID && value.name === wellName);
    const destination = serviceJob
      ? Object.values((wells.val() || {}) as Record<string, Record<string, unknown>>)
        .find(value => value.companyId === DEMO_COMPANY_ID && value.name === disposal)
      : disposalDocs.docs.find(doc => doc.get('displayName') === disposal
        && doc.get('isCustom') === true && doc.get('isBlacklisted') !== true);
    const driverProfile = driver.val() as Record<string, unknown> | null;
    if (!well || !destination || !driverProfile || driverProfile.companyId !== DEMO_COMPANY_ID
      || driverProfile.active === false) {
      throw new https.HttpsError('failed-precondition', 'demo_catalog_selection_required');
    }
    if (serviceJob) {
      if (driverId !== DEMO_PHONE_DRIVER_ID || well.route !== 'Unrouted' || well.isDemo !== true) {
        throw new https.HttpsError('failed-precondition', 'demo_service_well_unavailable');
      }
    } else {
      const pullPlan = await readDemoWellPullPlan(wellName);
      if (!pullPlan.ready) throw new https.HttpsError('failed-precondition', 'demo_well_recovering');
    }
    const revision = Number(packetHead.get('latestRevision'));
    if (!Number.isInteger(revision) || revision < 1) {
      throw new https.HttpsError('failed-precondition', 'demo_packet_missing');
    }
    const packet = await loadVerifiedRevision(DEMO_COMPANY_ID, { packageId: 'water-hauling', revision });
    if (!packet.ok) throw new https.HttpsError('failed-precondition', packet.reason);
    const jobType = resolveCanonicalJobType(serviceJob ? 'service-work' : 'pw', packet.envelope.jobTypes,
      Array.isArray(company.get('customJobTypes')) ? company.get('customJobTypes') : undefined);
    if (!jobType.ok) throw new https.HttpsError('failed-precondition', jobType.reason);

    const dispatches = fs.collection('dispatches');
    const created = await fs.runTransaction(async tx => {
      // Serialize all public-demo births through one gate. Completed jobs are
      // removed oldest first only when the hard cap is reached. Active jobs
      // remain untouched, and one driver cannot be given overlapping loads.
      const gate = fs.collection('live_demo').doc('viewer-dispatch-gate');
      await tx.get(gate);
      const existing = await tx.get(dispatches.where('companyId', '==', DEMO_COMPANY_ID));
      const jobs = existing.docs.map(doc => ({ ref: doc.ref, data: doc.data() }));
      if (jobs.some(job => job.data.driverId === driverId && ACTIVE.has(String(job.data.status)))) {
        throw new https.HttpsError('resource-exhausted', 'demo_driver_has_active_job');
      }
      if (jobs.some(job => job.data.wellName === wellName && ACTIVE.has(String(job.data.status)))) {
        throw new https.HttpsError('resource-exhausted', 'demo_well_has_active_job');
      }
      if (jobs.length >= MAX_JOBS) {
        const oldest = jobs.filter(job => FINISHED.has(String(job.data.status)))
          .sort((a, b) => (a.data.assignedAt?.toMillis?.() || 0) - (b.data.assignedAt?.toMillis?.() || 0))[0];
        if (!oldest) throw new https.HttpsError('resource-exhausted', 'demo_jobs_full');
        tx.delete(oldest.ref);
      }
      const ref = dispatches.doc();
      tx.create(ref, {
        ...stampDispatchBinding(packet.envelope),
        companyId: DEMO_COMPANY_ID,
        driverId, driverHash: driverId,
        driverName: String(driverProfile.legalName || driverProfile.displayName || 'Demo Driver'),
        driverFirstName: String(driverProfile.legalName || driverProfile.displayName || 'Demo').split(' ')[0],
        wellName, ndicWellName: '', operator: String(well.operator || 'Demo Operator'),
        route: String(well.route || 'Demo Route'), disposal,
        jobType: serviceJob ? 'service' : 'pw', jobTypeId: jobType.jobTypeId,
        ...(serviceJob ? { serviceType: 'Hot Oiler', bbls } : {}),
        status: 'pending', loadCount,
        notes, priority: 0,
        assignedAt: FieldValue.serverTimestamp(), assignedBy: VIEWER_UID,
        isDemo: true,
      });
      tx.set(gate, { lastDispatchAt: FieldValue.serverTimestamp() }, { merge: true });
      return ref.id;
    });
    return { dispatchId: created, companyId: DEMO_COMPANY_ID };
  },
);
