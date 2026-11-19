import * as admin from 'firebase-admin';
import * as https from 'firebase-functions/v2/https';
import {randomBytes, createHash} from 'crypto';
import {authenticate} from './intake';
import {messageReservationKey} from './messageReservation';
import {workerId, claimDecision, workerLeaseMs} from './workerCoordinationPolicy';
import {authorizeWatchdogOffice} from './remoteReview';

const options = {region: 'us-central1', timeoutSeconds: 60, secrets: ['WATCHDOG_HMAC_KEY_V1']};
const root = 'watchdog_workers/liquid-gold';

async function configured(body: any) {
  const id = workerId(body?.workerId);
  const config = (await admin.firestore().doc('watchdog_v2_config/laptop').get()).data();
  const worker = config?.workerCoordination?.workers?.[id];
  if (!config?.enabled || config.workerCoordination?.enabled !== true || worker?.enabled !== true ||
      !['main', 'backup'].includes(worker.role)) throw Error('worker_not_enabled');
  return {id, config, role: worker.role as 'main' | 'backup'};
}

export const reportWatchdogWorkerV2 = https.onRequest(options, async (req, res) => {
  try {
    await authenticate(req, 'reportWatchdogWorkerV2');
    const {id, role} = await configured(req.body);
    const report = req.body.report;
    if (!report || typeof report.state !== 'string' || report.state.length > 80 ||
        typeof report.paused !== 'boolean' || typeof report.sourceCommit !== 'string' || report.sourceCommit.length > 64 ||
        !Number.isInteger(report.pending) || report.pending < 0 || !Number.isInteger(report.review) || report.review < 0 ||
        typeof report.error !== 'string' || report.error.length > 500 || !Array.isArray(report.channels) ||
        report.channels.length > 100 || report.channels.some((c: any) => typeof c !== 'string' || c.length > 200)) throw Error('invalid_worker_report');
    const now = Date.now();
    const captureAt = typeof report.lastCaptureAt === 'string' ? Date.parse(report.lastCaptureAt) : NaN;
    const record = {workerId: id, role, state: report.state, paused: report.paused, sourceCommit: report.sourceCommit,
      pending: report.pending, review: report.review, channels: report.channels, error: report.error,
      // This is a capture heartbeat, never a claim that every message was delivered.
      captureHealthy: report.state === 'Connected' && !report.paused && !report.error &&
        Number.isFinite(captureAt) && captureAt <= now + 30_000 && now - captureAt < 120_000,
      lastCaptureAt: Number.isFinite(captureAt) ? captureAt : null,
      lastSeenAt: now};
    await admin.firestore().doc(root + '/hosts/' + id).set(record);
    const bucket = Math.floor(now / 300_000);
    await admin.firestore().doc(root + '/reports/' + id + '-' + bucket).set(record);
    res.json({ok: true, recordedAt: now});
  } catch (error) { res.status(400).json({ok: false, error: String((error as Error).message).slice(0, 200)}); }
});

export const claimWatchdogMessageV2 = https.onRequest(options, async (req, res) => {
  try {
    await authenticate(req, 'claimWatchdogMessageV2');
    const {id, role, config} = await configured(req.body);
    const {channel, messageId, rowIndex} = req.body;
    if (typeof channel !== 'string' || !channel || channel.length > 200 || !config.channels?.[channel] ||
        typeof messageId !== 'string' || !messageId || messageId.length > 500 ||
        !Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex > 10) throw Error('invalid_message_identity');
    const key = messageReservationKey(channel, messageId, rowIndex);
    const fs = admin.firestore();
    const reserved = (await fs.doc('watchdog_message_deliveries/' + key).get()).data();
    // Existing deliveries are resumed through the original receipt endpoint.
    // A failed/lost response must never become another observation/load.
    const messageHash = createHash('sha256').update(channel + ':' + messageId).digest('hex');
    const legacy = await fs.collection('watchdog_v2_deliveries').where('messageHash', '==', messageHash).get();
    const matching = legacy.docs.map(doc => ({...doc.data(), identity: doc.id}))
      .filter((entry: any) => entry.rowIndex === rowIndex || entry.rowIndex === undefined);
    const entries: any[] = reserved ? [reserved, ...matching] : matching;
    const packets = new Set(entries.map(entry => entry.packetId));
    if (packets.size > 1) throw Error('duplicate_message_attention');
    if (entries.length) {
      const entry = entries[0];
      const packet = (await admin.database().ref('packets/processed/' + entry.packetId).once('value')).val();
      const recorded = !!packet && packet.packetId === entry.packetId &&
        (entry.identity === 'app:' + entry.packetId || packet.source === 'whatsapp_watchdog' &&
          packet.watchdogProvenance?.observationDigest === entry.identity);
      await fs.doc(root + '/messages/' + key).set({messageHash, rowIndex, packetId: entry.packetId,
        identity: entry.identity, checkedBy: id, checkedAt: Date.now(),
        status: recorded ? 'recorded_once' : 'delivery_unconfirmed'}, {merge: true});
      res.json({ok: true, granted: false, receipt: {identity: entry.identity, packetId: entry.packetId,
        status: recorded ? 'complete' : 'queued', alreadyRecorded: recorded}});
      return;
    }
    const result = await fs.runTransaction(async tx => {
      const ref = fs.doc(root + '/messages/' + key);
      const previous = (await tx.get(ref)).data();
      const now = Date.now();
      const decision = claimDecision({now, role, workerId: id, previous: previous as any});
      const record = {messageHash, rowIndex, firstSeenAt: decision.firstSeenAt, checkedBy: id, checkedAt: now};
      if (!decision.granted) {
        tx.set(ref, record, {merge: true});
        return {granted: false, reason: decision.reason};
      }
      const token = randomBytes(16).toString('hex');
      tx.set(ref, {...record, owner: id, leaseUntil: now + workerLeaseMs, token,
        status: decision.reason}, {merge: true});
      return {granted: true, token, leaseUntil: now + workerLeaseMs};
    });
    res.json({ok: true, ...result});
  } catch (error) { res.status(400).json({ok: false, error: String((error as Error).message).slice(0, 200)}); }
});

export const listWatchdogWorkerReports = https.onCall({region: 'us-central1'}, async request => {
  const company = await authorizeWatchdogOffice(request);
  if (company !== 'liquid-gold') throw new https.HttpsError('permission-denied', 'Worker reports not in this company');
  const [hosts, messages] = await Promise.all([
    admin.firestore().collection(root + '/hosts').get(),
    admin.firestore().collection(root + '/messages').orderBy('checkedAt', 'desc').limit(50).get(),
  ]);
  const now = Date.now();
  return {checkedAt: now, workers: hosts.docs.map(doc => ({...doc.data(),
    stale: now - Number(doc.data().lastSeenAt || 0) > 120_000})),
    messages: messages.docs.map(doc => ({id: doc.id, ...doc.data()}))};
});
