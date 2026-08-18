/**
 * writeDiagnosticLog authorization — Firebase ID token only.
 * Bearer length/shape is not authentication.
 */
import { evaluateDriverAuthority } from './requireDriverAuth';

export const DIAG_ALLOWED_APPS = new Set(['wbs', 'wbt', 'wbjsa', 'dashboard', 'functions']);
export const DIAG_ALLOWED_AREAS = new Set([
  'jsa',
  'logout',
  'tickets',
  'dispatch',
  'split_load',
  'shift',
  'auth',
  'general',
  'transfer',
  'canonical',
]);
export const DIAG_ALLOWED_RESULTS = new Set(['ok', 'skipped', 'error']);

export const DIAG_MAX_PAYLOAD_BYTES = 16 * 1024;
export const DIAG_SENSITIVE_KEY_REGEX =
  /(passcode|password|secret|token|apikey|api[_-]?key|signature|sig[_-]|pdfbase64|photobase64|base64|authorization|bearer)/i;

/** Explicit Bearer credential (header or prose). Replaces the whole credential. */
const BEARER_CREDENTIAL = /\bBearer\s+\S+/gi;

/**
 * JWT-shaped signed credential: three base64url segments, header starts with
 * eyJ (typical JWT `{` prefix). Segment length avoids 1.2.3 / filenames / prose.
 */
const JWT_SHAPED_CREDENTIAL = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

export function redactDiagnosticString(value: string): string {
  let out = value.replace(BEARER_CREDENTIAL, 'Bearer [redacted]');
  out = out.replace(JWT_SHAPED_CREDENTIAL, '[redacted]');
  if (out.length > 2048) return `${out.slice(0, 2048)}…[trunc]`;
  return out;
}

const FORBIDDEN_IDENTITY_FIELDS = new Set([
  'driverId',
  'companyId',
  'uid',
  'userId',
  'role',
  'roles',
  'isAdmin',
  'wellbuiltAdmin',
  'platformAdminEnabled',
  'owner',
  'actorUid',
  'staffRole',
  'driverHash',
  'legacyDriverHash',
]);

export type DiagnosticAuthFailure = {
  ok: false;
  status: 401 | 403 | 400 | 405;
  code: string;
};

export type DiagnosticAuthSuccess = {
  ok: true;
  token: string;
};

export function extractBearerToken(authorizationHeader: unknown): DiagnosticAuthSuccess | DiagnosticAuthFailure {
  const raw = Array.isArray(authorizationHeader)
    ? String(authorizationHeader[0] || '')
    : String(authorizationHeader || '');
  if (!raw.trim()) {
    return { ok: false, status: 401, code: 'auth_required' };
  }
  const match = raw.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match || !match[1]) {
    return { ok: false, status: 401, code: 'auth_required' };
  }
  return { ok: true, token: match[1] };
}

export function forbiddenIdentityFields(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter((k) => FORBIDDEN_IDENTITY_FIELDS.has(k));
}

export function validateDiagnosticSchema(raw: unknown): DiagnosticAuthFailure | { ok: true; body: Record<string, unknown> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, status: 400, code: 'bad_body' };
  }
  const body = raw as Record<string, unknown>;
  const extra = forbiddenIdentityFields(body);
  if (extra.length) {
    return { ok: false, status: 400, code: 'identity_field_forbidden' };
  }
  let approxSize = 0;
  try {
    approxSize = JSON.stringify(raw).length;
  } catch {
    approxSize = DIAG_MAX_PAYLOAD_BYTES + 1;
  }
  if (approxSize > DIAG_MAX_PAYLOAD_BYTES) {
    return { ok: false, status: 400, code: 'payload_too_large' };
  }
  if (!DIAG_ALLOWED_APPS.has(String(body.app || ''))) {
    return { ok: false, status: 400, code: 'bad_app' };
  }
  if (!DIAG_ALLOWED_AREAS.has(String(body.area || ''))) {
    return { ok: false, status: 400, code: 'bad_area' };
  }
  if (!DIAG_ALLOWED_RESULTS.has(String(body.result || ''))) {
    return { ok: false, status: 400, code: 'bad_result' };
  }
  if (typeof body.event !== 'string' || !body.event) {
    return { ok: false, status: 400, code: 'bad_event' };
  }
  return { ok: true, body };
}

export function authorizeDiagnosticDriver(input: {
  uid: string | null | undefined;
  claims: Record<string, unknown> | null | undefined;
  profile: Record<string, unknown> | null;
}): { ok: true; driverId: string; companyId: string; uid: string } | DiagnosticAuthFailure {
  const decided = evaluateDriverAuthority({
    uid: input.uid,
    claims: input.claims,
    data: {},
    profile: input.profile,
  });
  if (!decided.ok) {
    if (decided.code === 'unauthenticated') {
      return { ok: false, status: 401, code: 'auth_required' };
    }
    return { ok: false, status: 403, code: 'not_authorized' };
  }
  return {
    ok: true,
    uid: decided.value.uid,
    driverId: decided.value.driverId,
    companyId: decided.value.companyId,
  };
}

export function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[depth-cap]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return redactDiagnosticString(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => sanitizeDiagnosticValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DIAG_SENSITIVE_KEY_REGEX.test(k)) {
        out[k] = '[redacted]';
        continue;
      }
      out[k] = sanitizeDiagnosticValue(v, depth + 1);
    }
    return out;
  }
  return '[unsupported]';
}
