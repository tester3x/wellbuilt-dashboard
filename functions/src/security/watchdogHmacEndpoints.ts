/**
 * HTTPS Endpoints for WhatsApp Watchdog Bridge.
 * Exposes ingestWatchdogPull and getWatchdogPullReceipt with HMAC authentication.
 */

import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {
  WATCHDOG_PRINCIPAL_ID,
  WATCHDOG_COMPANY_ID,
  WATCHDOG_SOURCE,
  verifyHmacHeaders,
  checkAndRecordNonce,
  validateObservationPayload,
  computeBodySha256,
  evaluateWatchdogReceipt,
} from './operational/watchdogHmac';
import { projectWellStatus } from './dashboardCatalogProjection';

export const ingestWatchdogPull = httpsV2.onRequest(
  { cors: true, region: 'us-central1', timeoutSeconds: 30, memory: '256MiB', secrets: ['WATCHDOG_HMAC_KEY_V1'] },
  async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.status(405).json({ ok: false, error: 'method_not_allowed' });
        return;
      }

      const db = admin.database();
      const rawBody = (req as any).rawBody || Buffer.from(typeof req.body === 'object' ? JSON.stringify(req.body) : String(req.body || ''), 'utf8');

      // 1. Verify HMAC headers
      const hmac = verifyHmacHeaders({
        endpointName: 'ingestWatchdogPull',
        method: 'POST',
        headers: req.headers,
        rawBody,
        nowMs: Date.now(),
      });

      if (!hmac.ok) {
        res.status(hmac.code).json({ ok: false, error: hmac.error });
        return;
      }

      // 2. Replay prevention: record nonce
      const nonce = (req.headers['x-watchdog-nonce'] || req.headers['x-hmac-nonce']) as string;
      const nonceOk = await checkAndRecordNonce(db, nonce, Date.now());
      if (!nonceOk) {
        res.status(401).json({ ok: false, error: 'replay_detected' });
        return;
      }

      // 3. Validate observation payload
      const val = validateObservationPayload(req.body, Date.now());
      if (!val.ok) {
        res.status(val.code).json({ ok: false, error: val.error });
        return;
      }

      const { packetId, wellName, top, bottom, bbl, dateTimeUTC, dateTime, timezone, observationDigest, rawPayload } = val.value;

      // 4. Verify well exists and is bound to liquid-gold
      const wellConfigSnap = await db.ref(`well_config/${wellName}`).once('value');
      if (wellConfigSnap.exists()) {
        const cfg = wellConfigSnap.val() || {};
        if (cfg.companyId && cfg.companyId !== WATCHDOG_COMPANY_ID) {
          res.status(403).json({ ok: false, error: 'cross_company_well_forbidden' });
          return;
        }
      }

      // 5. Check idempotency & payload conflict
      const bodySha = computeBodySha256(rawBody);
      const subRef = db.ref(`integration_ledgers/watchdog/submissions/${packetId}`);
      const existingSub = await subRef.once('value');
      if (existingSub.exists()) {
        const prev = existingSub.val() || {};
        if (prev.bodySha256 === bodySha) {
          res.status(200).json({ ok: true, packetId, duplicate: true, status: 'already_processed', submitted: false });
          return;
        }
        res.status(409).json({ ok: false, error: 'packet_payload_conflict' });
        return;
      }

      // 6. Check observation digest (alternate ID duplicate)
      const digestRef = db.ref(`integration_ledgers/watchdog/digests/${observationDigest}`);
      const existingDigest = await digestRef.once('value');
      if (existingDigest.exists()) {
        const priorPacketId = existingDigest.val()?.packetId;
        if (priorPacketId && priorPacketId !== packetId) {
          res.status(200).json({ ok: true, packetId: priorPacketId, duplicate: true, status: 'already_processed', submitted: false });
          return;
        }
      }

      // 7. Store to integration ledger
      await subRef.set({
        packetId,
        principalId: WATCHDOG_PRINCIPAL_ID,
        actingForCompany: WATCHDOG_COMPANY_ID,
        submittedAt: new Date().toISOString(),
        bodySha256: bodySha,
        observationDigest,
        wellName,
        top,
        bottom,
        bbl,
        dateTimeUTC,
      });
      await digestRef.set({
        packetId,
        observationDigest,
        submittedAt: new Date().toISOString(),
      });

      // 8. Write canonical incoming packet
      const incomingPacket = {
        packetId,
        idempotencyKey: packetId,
        requestType: 'pull',
        wellName,
        tankLevelFeet: top,
        bottomLevelFeet: bottom,
        bottom,
        bblsTaken: bbl,
        dateTimeUTC,
        dateTime,
        timezone,
        companyId: WATCHDOG_COMPANY_ID,
        source: WATCHDOG_SOURCE,
        origin: 'watchdog-sidecar',
        driverName: null,
        driverId: null,
        wellDownIsAuthoritative: false,
        watchdogProvenance: {
          principalId: WATCHDOG_PRINCIPAL_ID,
          actingForCompany: WATCHDOG_COMPANY_ID,
          observationDigest,
          chat: rawPayload.chat || null,
          sender: rawPayload.sender || null,
          parserVersion: rawPayload.parserVersion || null,
        },
      };

      await db.ref(`packets/incoming/${packetId}`).set(incomingPacket);

      res.status(200).json({
        ok: true,
        packetId,
        duplicate: false,
        status: 'queued',
        submitted: true,
      });
    } catch (err) {
      console.error('[ingestWatchdogPull] Unhandled error:', err);
      res.status(500).json({ ok: false, error: 'internal_server_error' });
    }
  },
);

export const getWatchdogPullReceipt = httpsV2.onRequest(
  { cors: true, region: 'us-central1', timeoutSeconds: 15, memory: '256MiB', secrets: ['WATCHDOG_HMAC_KEY_V1'] },
  async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.status(405).json({ ok: false, error: 'method_not_allowed' });
        return;
      }

      const db = admin.database();
      const rawBody = (req as any).rawBody || Buffer.from(typeof req.body === 'object' ? JSON.stringify(req.body) : String(req.body || ''), 'utf8');

      // 1. Verify HMAC headers
      const hmac = verifyHmacHeaders({
        endpointName: 'getWatchdogPullReceipt',
        method: req.method,
        headers: req.headers,
        rawBody,
        nowMs: Date.now(),
      });

      if (!hmac.ok) {
        res.status(hmac.code).json({ ok: false, error: hmac.error });
        return;
      }

      const packetId = ((req.query?.packetId as string) || req.body?.packetId || '').trim();
      if (!packetId) {
        res.status(400).json({ ok: false, error: 'missing_packet_id' });
        return;
      }

      // 2. Authorize via integration ledger
      const subSnap = await db.ref(`integration_ledgers/watchdog/submissions/${packetId}`).once('value');
      if (!subSnap.exists() || subSnap.val()?.principalId !== WATCHDOG_PRINCIPAL_ID) {
        res.status(404).json({ ok: false, found: false, status: 'not_found', packetId });
        return;
      }

      // 3. Query RTDB + the same outgoing projection adminGetWellPool uses
      const procSnap = await db.ref(`packets/processed/${packetId}`).once('value');
      if (procSnap.exists()) {
        const processed = procSnap.val() || {};
        const wellName = processed.wellName || subSnap.val()?.wellName;
        const [statusSnap, outgoingSnap, cfgSnap] = await Promise.all([
          db.ref(`wells/${wellName}/status`).once('value'),
          db.ref('packets/outgoing').once('value'),
          db.ref(`well_config/${wellName}`).once('value'),
        ]);
        const wellStatus = statusSnap.val() || null;
        const outgoingTree = (outgoingSnap.exists() ? outgoingSnap.val() : {}) as Record<string, unknown>;
        const pool = projectWellStatus(outgoingTree);
        const poolProjection = pool[wellName] || null;
        const responseId = poolProjection && typeof poolProjection.responseId === 'string' ? poolProjection.responseId : '';
        const rawOutgoing = responseId && outgoingTree[responseId] && typeof outgoingTree[responseId] === 'object'
          ? (outgoingTree[responseId] as Record<string, unknown>)
          : null;
        const outgoingPacketId = rawOutgoing && typeof rawOutgoing.lastPullPacketId === 'string'
          ? rawOutgoing.lastPullPacketId
          : null;
        const verdict = evaluateWatchdogReceipt({
          packetId,
          wellName,
          processed,
          wellStatus,
          poolProjection,
          outgoingPacketId,
          wellConfig: cfgSnap.exists() ? cfgSnap.val() : null,
        });

        res.status(verdict.ok ? 200 : 409).json({
          ok: verdict.ok,
          found: true,
          status: verdict.status,
          packetId,
          canonicalProcessingComplete: processed.canonicalProcessingComplete === true,
          canonicalCurrentLevelUpdated: verdict.canonicalCurrentLevelUpdated,
          wellName: verdict.wellName,
          wellKey: verdict.wellKey,
          companyId: verdict.companyId,
          reason: verdict.reason || null,
          wellStatus: {
            currentLevel: wellStatus?.current?.level || null,
            levelInches: wellStatus?.current?.levelInches ?? null,
          },
          adminGetWellPool: {
            currentLevel: verdict.poolCurrentLevel || null,
            lastPullDateTimeUTC: verdict.poolLastPullDateTimeUTC || null,
            lastPullPacketId: verdict.poolLastPullPacketId || null,
          },
        });
        return;
      }

      const incomingSnap = await db.ref(`packets/incoming/${packetId}`).once('value');
      if (incomingSnap.exists()) {
        res.status(200).json({ ok: true, found: true, status: 'queued', packetId });
        return;
      }

      const rejSnap = await db.ref(`packets/rejected/${packetId}`).once('value');
      if (rejSnap.exists()) {
        res.status(200).json({ ok: true, found: true, status: 'rejected', packetId, verdict: rejSnap.val()?.verdict || null });
        return;
      }

      res.status(200).json({ ok: true, found: false, status: 'unknown', packetId });
    } catch (err) {
      console.error('[getWatchdogPullReceipt] Unhandled error:', err);
      res.status(500).json({ ok: false, error: 'internal_server_error' });
    }
  },
);
