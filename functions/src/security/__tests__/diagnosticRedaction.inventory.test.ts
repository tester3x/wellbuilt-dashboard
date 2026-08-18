/**
 * C4 redaction surface — key names, nesting, in-string Bearer/JWT, false positives.
 */
import {
  DIAG_SENSITIVE_KEY_REGEX,
  redactDiagnosticString,
  sanitizeDiagnosticValue,
} from '../diagnosticAuth';

/** Synthetic canary JWT (three long base64url segments, eyJ header). */
export const CANARY_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjYW5hcnktc3ViLWlkeHh4eHh4eHh4eCIsIm5hbWUiOiJDYW5hcnkifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
export const CANARY_OPAQUE = 'CANARY_OPAQUE_CREDENTIAL_c4_9f3a7b21';

function redactMap(input: Record<string, unknown>) {
  return sanitizeDiagnosticValue(input) as Record<string, unknown>;
}

describe('C4 sanitizer claimed key-based contract', () => {
  it('redacts token-family / password / passcode / secret / signature keys at top level', () => {
    const out = redactMap({
      token: 't',
      idToken: 'id',
      refreshToken: 'rt',
      accessToken: 'at',
      customToken: 'ct',
      password: 'pw',
      passcode: 'pc',
      secret: 's',
      signature: 'sig',
      apiKey: 'k',
      note: 'plain',
    });
    for (const k of [
      'token', 'idToken', 'refreshToken', 'accessToken', 'customToken',
      'password', 'passcode', 'secret', 'signature', 'apiKey',
    ]) {
      expect(out[k]).toBe('[redacted]');
    }
    expect(out.note).toBe('plain');
  });

  it('redacts mixed-case keys and nested objects', () => {
    const out = redactMap({
      PassCode: 'x',
      TOKEN: 'y',
      nested: { refreshToken: 'z', note: 'plain' },
    });
    expect(out.PassCode).toBe('[redacted]');
    expect(out.TOKEN).toBe('[redacted]');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.refreshToken).toBe('[redacted]');
    expect(nested.note).toBe('plain');
  });

  it('redacts sensitive keys inside array objects and preserves plain notes', () => {
    const out = sanitizeDiagnosticValue([
      { passcode: 'x', note: 'plain' },
      { idToken: 'y', note: 'plain' },
    ]) as Array<Record<string, unknown>>;
    expect(out[0].passcode).toBe('[redacted]');
    expect(out[0].note).toBe('plain');
    expect(out[1].idToken).toBe('[redacted]');
    expect(out[1].note).toBe('plain');
  });
});

describe('authorization and bearer keys at every nesting and casing', () => {
  it('matches authorization and bearer keys case-insensitively', () => {
    expect(DIAG_SENSITIVE_KEY_REGEX.test('authorization')).toBe(true);
    expect(DIAG_SENSITIVE_KEY_REGEX.test('Authorization')).toBe(true);
    expect(DIAG_SENSITIVE_KEY_REGEX.test('BEARER')).toBe(true);
    expect(DIAG_SENSITIVE_KEY_REGEX.test('bearer')).toBe(true);
  });

  it('redacts authorization/bearer at top level, nested, and in arrays', () => {
    const out = redactMap({
      authorization: `Bearer ${CANARY_OPAQUE}`,
      Authorization: `Bearer ${CANARY_JWT}`,
      bearer: CANARY_JWT,
      Bearer: CANARY_OPAQUE,
      nested: { authorization: CANARY_JWT, bearer: CANARY_OPAQUE, note: 'plain' },
      list: [{ Authorization: CANARY_JWT, note: 'plain' }],
    });
    expect(out.authorization).toBe('[redacted]');
    expect(out.Authorization).toBe('[redacted]');
    expect(out.bearer).toBe('[redacted]');
    expect(out.Bearer).toBe('[redacted]');
    const nested = out.nested as Record<string, unknown>;
    expect(nested.authorization).toBe('[redacted]');
    expect(nested.bearer).toBe('[redacted]');
    expect(nested.note).toBe('plain');
    const list = out.list as Array<Record<string, unknown>>;
    expect(list[0].Authorization).toBe('[redacted]');
    expect(list[0].note).toBe('plain');
    const blob = JSON.stringify(out);
    expect(blob).not.toContain(CANARY_OPAQUE);
    expect(blob).not.toContain(CANARY_JWT);
    expect(blob).not.toContain('eyJhbGci');
  });
});

describe('in-string Bearer and JWT-shaped credentials', () => {
  it('redacts explicit Bearer credentials including Authorization: Bearer', () => {
    const a = redactDiagnosticString(`Bearer ${CANARY_OPAQUE}`);
    const b = redactDiagnosticString(`Authorization: Bearer ${CANARY_JWT}`);
    expect(a).toBe('Bearer [redacted]');
    expect(b).toBe('Authorization: Bearer [redacted]');
    expect(a).not.toContain(CANARY_OPAQUE);
    expect(b).not.toContain(CANARY_JWT);
  });

  it('redacts JWT-shaped credentials embedded in ordinary strings', () => {
    const out = redactDiagnosticString(`failed with ${CANARY_JWT} at login`);
    expect(out).toBe('failed with [redacted] at login');
    expect(out).not.toContain('eyJ');
    expect(out).not.toContain(CANARY_JWT.split('.')[1]);
  });

  it('redacts multiple credentials in one string', () => {
    const out = redactDiagnosticString(
      `Bearer ${CANARY_OPAQUE} then ${CANARY_JWT} and Bearer ${CANARY_JWT}`,
    );
    expect(out).toBe('Bearer [redacted] then [redacted] and Bearer [redacted]');
    expect(out).not.toContain(CANARY_OPAQUE);
    expect(out).not.toContain(CANARY_JWT);
  });
});

describe('false-positive preservation', () => {
  it('preserves harmless dotted and ordinary strings', () => {
    const keep = [
      'plain',
      '1.2.3',
      'see section 2.3.4 of the guide',
      '3.14',
      'photo.ticket.final.jpg',
      'https://example.com/path/to/resource',
      'driver_drvb_session_abc123def456',
    ];
    for (const s of keep) {
      expect(redactDiagnosticString(s)).toBe(s);
    }
    const obj = redactMap({
      note: 'plain',
      version: '1.2.3',
      url: 'https://example.com/path/to/resource',
      file: 'photo.ticket.final.jpg',
      count: 3.14,
      ok: true,
      empty: null,
    });
    expect(obj.note).toBe('plain');
    expect(obj.version).toBe('1.2.3');
    expect(obj.url).toBe('https://example.com/path/to/resource');
    expect(obj.file).toBe('photo.ticket.final.jpg');
    expect(obj.count).toBe(3.14);
    expect(obj.ok).toBe(true);
    expect(obj.empty).toBeNull();
  });
});
