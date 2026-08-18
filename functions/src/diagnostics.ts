/**
 * writeDiagnosticLog — authenticated HTTPS ingest for field-app diagnostics.
 *
 * Authentication is a verified Firebase ID token. Bearer length/shape is
 * not a principal. Driver/company are taken from verified claims + RTDB
 * profile. Client identity-selection fields are rejected before write.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import {
  authorizeDiagnosticDriver,
  extractBearerToken,
  redactDiagnosticString,
  sanitizeDiagnosticValue,
  validateDiagnosticSchema,
} from './security/diagnosticAuth';

function publicError(
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
  status: number,
  code: string,
): void {
  res.status(status).json({ ok: false, error: code });
}

export const writeDiagnosticLog = httpsV2.onRequest(
  { cors: true, region: 'us-central1' },
  async (req, res) => {
    try {
      if (req.method !== 'POST') {
        publicError(res, 405, 'method_not_allowed');
        return;
      }

      const extracted = extractBearerToken(req.headers.authorization || req.headers.Authorization);
      if (!extracted.ok) {
        publicError(res, extracted.status, extracted.code);
        return;
      }

      let decoded: admin.auth.DecodedIdToken;
      try {
        decoded = await admin.auth().verifyIdToken(extracted.token);
      } catch {
        publicError(res, 401, 'auth_required');
        return;
      }

      const claimDriverId = typeof decoded.driverId === 'string' ? decoded.driverId : '';
      const prof = claimDriverId
        ? await admin.database().ref(`drivers/profiles/${claimDriverId}`).once('value')
        : null;
      const authorized = authorizeDiagnosticDriver({
        uid: decoded.uid,
        claims: decoded as unknown as Record<string, unknown>,
        profile: prof && prof.exists() ? (prof.val() as Record<string, unknown>) : null,
      });
      if (!authorized.ok) {
        publicError(res, authorized.status, authorized.code);
        return;
      }

      const schema = validateDiagnosticSchema(req.body);
      if (!schema.ok) {
        publicError(res, schema.status, schema.code);
        return;
      }
      const raw = schema.body;

      const doc: Record<string, unknown> = {
        timestamp: FieldValue.serverTimestamp(),
        clientTimestamp:
          typeof raw.clientTimestamp === 'string' ? redactDiagnosticString(raw.clientTimestamp).slice(0, 80) : null,
        app: raw.app,
        area: raw.area,
        event: redactDiagnosticString(String(raw.event)).slice(0, 120),
        driverId: authorized.driverId,
        companyId: authorized.companyId,
        shiftId: typeof raw.shiftId === 'string' ? redactDiagnosticString(raw.shiftId).slice(0, 64) : null,
        operatorSlug:
          typeof raw.operatorSlug === 'string' ? redactDiagnosticString(raw.operatorSlug).slice(0, 64) : null,
        operatorId:
          typeof raw.operatorId === 'string' ? redactDiagnosticString(raw.operatorId).slice(0, 64) : null,
        source: typeof raw.source === 'string' ? redactDiagnosticString(raw.source).slice(0, 200) : null,
        result: raw.result,
        reason: typeof raw.reason === 'string' ? redactDiagnosticString(raw.reason).slice(0, 500) : null,
        counts:
          raw.counts && typeof raw.counts === 'object' && !Array.isArray(raw.counts)
            ? sanitizeDiagnosticValue(raw.counts, 1)
            : null,
        extra:
          raw.extra && typeof raw.extra === 'object' && !Array.isArray(raw.extra)
            ? sanitizeDiagnosticValue(raw.extra)
            : null,
        appVersion:
          typeof raw.appVersion === 'string' ? redactDiagnosticString(raw.appVersion).slice(0, 40) : null,
        platform: typeof raw.platform === 'string' ? redactDiagnosticString(raw.platform).slice(0, 20) : null,
      };

      await admin.firestore().collection('wb_diagnostics').add(doc);
      res.status(200).json({ ok: true });
    } catch {
      publicError(res, 500, 'error');
    }
  },
);
