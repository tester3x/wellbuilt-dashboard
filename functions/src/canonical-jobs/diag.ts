// CF-side diagnostic helper for the canonical_jobs Phase 1 layer.
//
// Writes directly to wb_diagnostics via Admin SDK (CFs bypass the HTTPS
// writeDiagnosticLog endpoint). Mirrors the doc shape produced by
// writeDiagnosticLog so the existing /admin/diagnostics viewer renders
// these rows alongside app-emitted events.
//
// Never throws. Failures inside the logger are swallowed — diagnostic
// instrumentation must never affect business flow.
//
// MIRROR FILE: wellbuilt-tickets/functions/src/canonical-jobs/diag.ts

import * as admin from 'firebase-admin';

export type CanonicalDiagLevel = 'info' | 'warn' | 'error';
export type CanonicalDiagSource = 'wbm' | 'wbt' | 'cf' | 'dashboard';

interface CanonicalDiagInput {
  level: CanonicalDiagLevel;
  event: string;
  payload?: Record<string, unknown> | null;
  source: CanonicalDiagSource;
  driverHash?: string | null;
  reason?: string | null;
}

const MAX_STRING_LEN = 2048;
const MAX_DEPTH = 3;
const MAX_ARRAY_LEN = 50;
const SENSITIVE_KEY_REGEX =
  /(passcode|password|secret|token|apikey|api[_-]?key|signature|sig[_-]|pdfbase64|photobase64|base64)/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth-cap]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LEN ? value.slice(0, MAX_STRING_LEN) + '…[trunc]' : value;
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

export async function logCanonicalDiag(input: CanonicalDiagInput): Promise<void> {
  try {
    const result =
      input.level === 'error' ? 'error' : input.level === 'warn' ? 'skipped' : 'ok';
    const doc: Record<string, unknown> = {
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      clientTimestamp: new Date().toISOString(),
      app: 'functions',
      area: 'canonical',
      event: String(input.event).slice(0, 120),
      driverHash: input.driverHash ?? null,
      shiftId: null,
      operatorSlug: null,
      operatorId: null,
      source: input.source,
      result,
      reason: input.reason ?? null,
      counts: null,
      extra: input.payload ? sanitize(input.payload) : null,
      appVersion: null,
      platform: 'cf',
    };
    await admin.firestore().collection('wb_diagnostics').add(doc);
  } catch {
    // never throw from a logger
  }
}
