// ============================================================
// WellBuilt diagnostic logging — Phase 1
//
// Public HTTPS endpoint that ingests diagnostic events from WB T /
// WB JSA / WB S / dashboard / functions and writes them to the
// Firestore `wb_diagnostics` collection. Apps fire-and-forget,
// failures never block workflow.
//
// Why an HTTPS function (not direct Firestore writes from apps):
//   - Apps authenticate via name+passcode → SHA-256 → RTDB. They
//     have no Firebase Auth identity, so Firestore rules can't
//     enforce per-driver write scoping. A rule of `allow create: if
//     true` would expose the collection to spam from anyone with
//     the project ID.
//   - Centralizes sanitization (sensitive-key blacklist, depth/size
//     caps) in one place that apps can't bypass.
//   - Easy kill switch: redeploy as a no-op if it ever misbehaves
//     without needing app rebuilds.
//   - Validation: rejects payloads whose driverHash is not an
//     active driver in `drivers/approved/{hash}`.
//
// Phase 1 deliberately omits TTL and sampling — both deferred per
// approved design.
// ============================================================
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

const ALLOWED_APPS = new Set(['wbs', 'wbt', 'wbjsa', 'dashboard', 'functions']);
const ALLOWED_AREAS = new Set([
  'jsa',
  'logout',
  'tickets',
  'dispatch',
  'split_load',
  'shift',
  'auth',
  'general',
  'transfer',
]);
const ALLOWED_RESULTS = new Set(['ok', 'skipped', 'error']);

// Sensitive key matcher — covers passcode/password/token/secret/
// signature blobs / PDF + photo base64. Defense-in-depth: app
// helpers run the same regex before sending, but we re-run it here
// so an old client can't accidentally leak.
const SENSITIVE_KEY_REGEX = /(passcode|password|secret|token|apikey|api[_-]?key|signature|sig[_-]|pdfbase64|photobase64|base64)/i;

const MAX_STRING_LEN = 2048;
const MAX_DEPTH = 3;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_ARRAY_LEN = 50;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth-cap]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LEN
      ? value.slice(0, MAX_STRING_LEN) + '…[trunc]'
      : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LEN).map((v) => sanitize(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return '[unsupported]';
}

export const writeDiagnosticLog = httpsV2.onRequest(
  { cors: true, region: 'us-central1' },
  async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.status(405).send('POST only');
        return;
      }

      const raw = req.body;
      if (!raw || typeof raw !== 'object') {
        res.status(400).send('bad body');
        return;
      }

      // Crude payload size check before doing anything expensive.
      // Express has already parsed JSON for us; this catches abusive
      // clients that try to slip through with very deep / wide
      // payloads.
      let approxSize = 0;
      try {
        approxSize = JSON.stringify(raw).length;
      } catch {
        approxSize = MAX_PAYLOAD_BYTES + 1;
      }
      if (approxSize > MAX_PAYLOAD_BYTES) {
        res.status(413).send('payload too large');
        return;
      }

      if (!ALLOWED_APPS.has(raw.app)) {
        res.status(400).send('bad app');
        return;
      }
      if (!ALLOWED_AREAS.has(raw.area)) {
        res.status(400).send('bad area');
        return;
      }
      if (!ALLOWED_RESULTS.has(raw.result)) {
        res.status(400).send('bad result');
        return;
      }
      if (typeof raw.event !== 'string' || !raw.event) {
        res.status(400).send('bad event');
        return;
      }

      // When a driverHash is provided, validate against RTDB so
      // random POSTers can't pollute the collection. Apps without
      // a driver context (e.g. dashboard observability events)
      // omit driverHash and skip this gate.
      if (raw.driverHash) {
        if (typeof raw.driverHash !== 'string' || !/^[a-f0-9]{16,128}$/i.test(raw.driverHash)) {
          res.status(400).send('bad driverHash');
          return;
        }
        const snap = await admin
          .database()
          .ref(`drivers/approved/${raw.driverHash}/active`)
          .get();
        if (!snap.exists() || snap.val() !== true) {
          res.status(403).send('unknown driver');
          return;
        }
      }

      const doc: Record<string, unknown> = {
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        clientTimestamp:
          typeof raw.clientTimestamp === 'string' ? raw.clientTimestamp : null,
        app: raw.app,
        area: raw.area,
        event: String(raw.event).slice(0, 120),
        driverHash: raw.driverHash || null,
        shiftId: typeof raw.shiftId === 'string' ? raw.shiftId.slice(0, 64) : null,
        operatorSlug:
          typeof raw.operatorSlug === 'string' ? raw.operatorSlug.slice(0, 64) : null,
        operatorId:
          typeof raw.operatorId === 'string' ? raw.operatorId.slice(0, 64) : null,
        source: typeof raw.source === 'string' ? raw.source.slice(0, 200) : null,
        result: raw.result,
        reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 500) : null,
        counts:
          raw.counts && typeof raw.counts === 'object' && !Array.isArray(raw.counts)
            ? sanitize(raw.counts, 1)
            : null,
        extra:
          raw.extra && typeof raw.extra === 'object' && !Array.isArray(raw.extra)
            ? sanitize(raw.extra)
            : null,
        appVersion:
          typeof raw.appVersion === 'string' ? raw.appVersion.slice(0, 40) : null,
        platform:
          typeof raw.platform === 'string' ? raw.platform.slice(0, 20) : null,
      };

      await admin.firestore().collection('wb_diagnostics').add(doc);
      res.status(204).end();
    } catch (err: any) {
      // Logging the logger — never re-throw. Apps are fire-and-
      // forget so they ignore the response anyway, but we want a
      // server-side breadcrumb if writes start failing.
      console.warn('[writeDiagnosticLog] error:', err?.message || err);
      res.status(500).send('error');
    }
  },
);
