/**
 * ingestWatchdogPull — Authenticated callable for verified WhatsApp Watchdog pulls.
 *
 * Dedicated Watchdog principal only (custom claim kind=watchdog).
 * Server-authoritative companyId; client override is strictly forbidden.
 * Validates measurements and well ownership. Checks idempotency across
 * incoming/processed/rejected. Writes strictly to packets/incoming.
 * Never creates commercial records (tickets, invoices, billing, payroll, dispatches)
 * and never creates/impersonates a driver.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { writeSecurityAudit } from './audit';
import {
  validateWatchdogPull,
  buildWatchdogPullPacket,
  assertNoCommercialProjection,
  type WatchdogPullInput,
} from './operational/watchdogPull';

const ALLOWED_KEYS = new Set([
  'packetId', 'wellName', 'dateTimeUTC', 'dateTime', 'timezone',
  'tankLevelFeet', 'bblsTaken', 'idempotencyKey', 'requestType',
  'wellDown', 'wellDownIsAuthoritative', 'predictedLevelInches',
  'chat', 'sender', 'eventTimeLocal', 'observedUtc', 'top', 'bottom',
  'explicitBbl', 'parserVersion', 'digest', 'evidenceRef', 'watchdogProvenance',
]);

export interface WatchdogPrincipal {
  uid: string;
  companyId: string;
}

export function requireWatchdogPrincipal(request: httpsV2.CallableRequest<unknown>): WatchdogPrincipal {
  if (!request.auth || !request.auth.uid) {
    throw new httpsV2.HttpsError('unauthenticated', 'unauthenticated:Sign in with a dedicated Watchdog principal.');
  }

  const token = request.auth.token as Record<string, unknown>;
  if (token.kind !== 'watchdog') {
    throw new httpsV2.HttpsError(
      'permission-denied',
      'watchdog_kind_required:Dedicated Watchdog authorization required (kind=watchdog).',
    );
  }

  const companyId = typeof token.companyId === 'string' ? token.companyId.trim() : '';
  if (!companyId) {
    throw new httpsV2.HttpsError(
      'failed-precondition',
      'company_required:No company is bound to this Watchdog principal.',
    );
  }

  return {
    uid: request.auth.uid,
    companyId,
  };
}

export const ingestWatchdogPull = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = requireWatchdogPrincipal(request);

    const raw = (request.data || {}) as Record<string, unknown>;

    // Client companyId override is forbidden
    if ('companyId' in raw) {
      throw new httpsV2.HttpsError(
        'invalid-argument',
        'company_override_forbidden:Company is server-controlled and cannot be passed in payload.',
      );
    }

    for (const key of Object.keys(raw)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }

    const verdict = validateWatchdogPull(raw as WatchdogPullInput, {
      actorUid: caller.uid,
      companyId: caller.companyId,
      nowMs: Date.now(),
    });

    if (!verdict.ok) {
      throw new httpsV2.HttpsError('invalid-argument', `${verdict.reason}:${verdict.message}`);
    }

    const { packetId, packet } = buildWatchdogPullPacket(verdict.value, {
      actorUid: caller.uid,
      companyId: caller.companyId,
      nowMs: Date.now(),
    });

    assertNoCommercialProjection(packet);

    const rtdb = admin.database();

    // Verify well exists and belongs to the caller's company
    const wellSnap = await rtdb.ref(`well_config/${verdict.value.wellName}`).once('value');
    if (!wellSnap.exists()) {
      throw new httpsV2.HttpsError(
        'failed-precondition',
        `well_not_found:Well ${verdict.value.wellName} does not exist.`,
      );
    }
    const wellCfg = wellSnap.val() as Record<string, unknown>;
    if (wellCfg.companyId && wellCfg.companyId !== caller.companyId) {
      throw new httpsV2.HttpsError(
        'permission-denied',
        `cross_company_well_forbidden:Well ${verdict.value.wellName} does not belong to authorized company.`,
      );
    }

    // Atomic idempotency check across processed, incoming, rejected
    for (const path of [`packets/processed/${packetId}`, `packets/incoming/${packetId}`]) {
      const snap = await rtdb.ref(path).once('value');
      if (snap.exists()) {
        await writeSecurityAudit({
          action: 'ingestWatchdogPull',
          actorUid: caller.uid,
          detail: {
            packetId,
            wellName: verdict.value.wellName,
            companyId: caller.companyId,
            duplicate: true,
            status: path.startsWith('packets/processed') ? 'already_processed' : 'already_queued',
          },
        });
        return {
          ok: true as const,
          packetId,
          duplicate: true,
          status: path.startsWith('packets/processed') ? 'already_processed' : 'already_queued',
          submitted: false,
        };
      }
    }

    const rejSnap = await rtdb.ref(`packets/rejected/${packetId}`).once('value');
    if (rejSnap.exists()) {
      const rej = rejSnap.val() as Record<string, unknown>;
      return {
        ok: false as const,
        packetId,
        duplicate: true,
        status: 'already_rejected',
        reason: (rej.reason as string) || 'rejected',
        submitted: false,
      };
    }

    // Write strictly to canonical WB-M incoming
    await rtdb.ref(`packets/incoming/${packetId}`).set(packet);

    await writeSecurityAudit({
      action: 'ingestWatchdogPull',
      actorUid: caller.uid,
      detail: {
        packetId,
        wellName: verdict.value.wellName,
        companyId: caller.companyId,
        tankLevelFeet: verdict.value.tankLevelFeet,
        bblsTaken: verdict.value.bblsTaken,
        dateTimeUTC: verdict.value.dateTimeUTC,
        duplicate: false,
      },
    });

    return {
      ok: true as const,
      packetId,
      duplicate: false,
      status: 'queued' as const,
      submitted: true,
    };
  },
);
