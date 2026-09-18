/**
 * Canonical Driver Reset Design — Phase 0 Contract & Validator Unit Tests
 *
 * Exhaustive unit tests verifying pure validators, contract shapes, boundary conditions,
 * immutability, fail-closed semantics, and zero secret leakage.
 *
 * NOTE: All test identities, credentials, and data are 100% synthetic.
 * No real persons, companies, passcodes, or production data are used.
 */

import {
  PASSCODE_DIGIT_MIN_LEN,
  PASSCODE_DIGIT_MAX_LEN,
  type CanonicalResetRequest,
  type CanonicalCredential,
  type DriverSessionBinding,
  type ResetReceipt,
  type AuthCleanupEffect,
} from '../resetDesign/contracts';

import {
  validateCanonicalResetRequest,
  validateCanonicalCredential,
  validateDriverSessionBinding,
  validateSessionVersionMatch,
  validateResetReceipt,
  validateAuthCleanupEffect,
  validateReceiptEffectAlignment,
} from '../resetDesign/validate';

// ── Synthetic Test Fixtures ──────────────────────────────────────────────────

const SYNTHETIC_OP_ID = 'op_syn_req_1001';
const SYNTHETIC_CO_ID = 'co_syn_tenant_alpha';
const SYNTHETIC_DRIVER_ID = 'drv_syn_driver_001';
const SYNTHETIC_ACTOR_UID = 'staff_syn_admin_001';
const SYNTHETIC_SALT_B64 = 'c3ludGhldGljX3NhbHRfZm9yX3Rlc3RpbmdfMTY='; // 27 bytes decoded
const SYNTHETIC_HASH_B64 = 'c3ludGhldGljX2hhc2hfMzJieXRlc19mb3JfdGVzdGluZ19zY3J5cHQ='; // 40 bytes decoded

function createValidSyntheticRequest(): CanonicalResetRequest {
  return {
    opId: SYNTHETIC_OP_ID,
    companyId: SYNTHETIC_CO_ID,
    driverId: SYNTHETIC_DRIVER_ID,
    expectedCredentialVersion: 1,
    temporary: true,
    newPasscode: '123456',
  };
}

function createValidSyntheticCredential(): CanonicalCredential {
  return {
    algo: 'scrypt',
    N: 16384,
    r: 8,
    p: 1,
    keyLen: 32,
    saltB64: SYNTHETIC_SALT_B64,
    hashB64: SYNTHETIC_HASH_B64,
    driverId: SYNTHETIC_DRIVER_ID,
    companyId: SYNTHETIC_CO_ID,
    credentialVersion: 1,
    active: true,
  };
}

describe('Canonical Driver Reset Phase 0 Contracts & Pure Validators', () => {
  // ── 1. Valid temporary-reset request ───────────────────────────────────────
  test('1. Valid temporary-reset request passes validation', () => {
    const req = createValidSyntheticRequest();
    const result = validateCanonicalResetRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.temporary).toBe(true);
      expect(result.value.expectedCredentialVersion).toBe(1);
      expect(result.value.newPasscode).toBe('123456');
    }
  });

  // ── 2. Valid request with temporary: false ─────────────────────────────────
  test('2. Valid request with temporary:false is structurally valid contract value', () => {
    const req = { ...createValidSyntheticRequest(), temporary: false };
    const result = validateCanonicalResetRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.temporary).toBe(false);
    }
  });

  // ── 3. Every required request field missing individually ───────────────────
  describe('3. Every required request field missing individually fails closed', () => {
    const fields: (keyof CanonicalResetRequest)[] = [
      'opId',
      'companyId',
      'driverId',
      'expectedCredentialVersion',
      'temporary',
      'newPasscode',
    ];

    fields.forEach((field) => {
      test(`missing field '${field}' is rejected`, () => {
        const req: Record<string, unknown> = { ...createValidSyntheticRequest() };
        delete req[field];
        const result = validateCanonicalResetRequest(req);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('missing_field');
          expect(result.error.path).toBe(field);
        }
      });

      test(`null field '${field}' is rejected`, () => {
        const req: Record<string, unknown> = { ...createValidSyntheticRequest() };
        req[field] = null;
        const result = validateCanonicalResetRequest(req);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('missing_field');
          expect(result.error.path).toBe(field);
        }
      });
    });
  });

  // ── 4. Unknown request field rejection ─────────────────────────────────────
  test('4. Unknown request field rejection fails closed on unexpected properties', () => {
    const req = {
      ...createValidSyntheticRequest(),
      unrecognizedField: 'unexpected',
    };
    const result = validateCanonicalResetRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown_field');
      expect(result.error.path).toBe('unrecognizedField');
    }
  });

  // ── 5. Missing credential version ──────────────────────────────────────────
  test('5. Missing credential version fails closed', () => {
    const req: Record<string, unknown> = { ...createValidSyntheticRequest() };
    delete req.expectedCredentialVersion;
    const result = validateCanonicalResetRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('missing_field');
      expect(result.error.path).toBe('expectedCredentialVersion');
    }
  });

  // ── 6. Zero, negative, fractional, unsafe, string, null, malformed versions ─
  describe('6. Invalid expectedCredentialVersion values fail closed', () => {
    const invalidVersions = [
      { val: 0, desc: 'zero' },
      { val: -1, desc: 'negative' },
      { val: -100, desc: 'deeply negative' },
      { val: 1.5, desc: 'fractional' },
      { val: NaN, desc: 'NaN' },
      { val: Infinity, desc: 'Infinity' },
      { val: -Infinity, desc: '-Infinity' },
      { val: Number.MAX_SAFE_INTEGER + 10, desc: 'unsafe integer' },
      { val: '1', desc: 'numeric string' },
      { val: 'version_1', desc: 'alpha string' },
      { val: false, desc: 'boolean' },
      { val: {}, desc: 'object' },
      { val: [1], desc: 'array' },
    ];

    invalidVersions.forEach(({ val, desc }) => {
      test(`rejects ${desc} version (${String(val)})`, () => {
        const req = {
          ...createValidSyntheticRequest(),
          expectedCredentialVersion: val,
        };
        const result = validateCanonicalResetRequest(req);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(['invalid_integer_type', 'unsafe_integer', 'non_positive_integer']).toContain(
            result.error.code,
          );
        }
      });
    });
  });

  // ── 7. temporary missing or nonboolean ─────────────────────────────────────
  describe('7. temporary missing or nonboolean fails closed', () => {
    const invalidTemporaries = [
      { val: 'true', desc: 'string "true"' },
      { val: 'false', desc: 'string "false"' },
      { val: 1, desc: 'number 1' },
      { val: 0, desc: 'number 0' },
      { val: {}, desc: 'empty object' },
      { val: [], desc: 'array' },
    ];

    invalidTemporaries.forEach(({ val, desc }) => {
      test(`rejects non-boolean temporary: ${desc}`, () => {
        const req = { ...createValidSyntheticRequest(), temporary: val };
        const result = validateCanonicalResetRequest(req);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('invalid_temporary_type');
          expect(result.error.path).toBe('temporary');
        }
      });
    });
  });

  // ── 8. Passcodes of 5, 6, 128, and 129 digits ─────────────────────────────
  describe('8. Passcode length boundaries (5, 6, 128, 129 digits)', () => {
    test('5-digit passcode is rejected (too short)', () => {
      const req = { ...createValidSyntheticRequest(), newPasscode: '12345' };
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('passcode_too_short');
      }
    });

    test('6-digit passcode is accepted (minimum boundary)', () => {
      const req = { ...createValidSyntheticRequest(), newPasscode: '123456' };
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(true);
    });

    test('128-digit passcode is accepted (maximum boundary)', () => {
      const passcode128 = '9'.repeat(128);
      const req = { ...createValidSyntheticRequest(), newPasscode: passcode128 };
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(true);
    });

    test('129-digit passcode is rejected (too long)', () => {
      const passcode129 = '9'.repeat(129);
      const req = { ...createValidSyntheticRequest(), newPasscode: passcode129 };
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('passcode_too_long');
      }
    });
  });

  // ── 9. Nonnumeric passcodes ───────────────────────────────────────────────
  describe('9. Nonnumeric passcodes are strictly rejected', () => {
    const nonNumericPasscodes = [
      '12345a',
      'abcdef',
      '123 456',
      '123-456',
      '123_456',
      '12345\n',
      '123.456',
      '!@#$%^',
      '12345e6',
    ];

    nonNumericPasscodes.forEach((passcode) => {
      test(`rejects nonnumeric passcode "${passcode.replace('\n', '\\n')}"`, () => {
        const req = { ...createValidSyntheticRequest(), newPasscode: passcode };
        const result = validateCanonicalResetRequest(req);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('passcode_non_numeric');
        }
      });
    });
  });

  // ── 10. Empty passcode ────────────────────────────────────────────────────
  test('10. Empty passcode is rejected', () => {
    const req = { ...createValidSyntheticRequest(), newPasscode: '' };
    const result = validateCanonicalResetRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('empty_passcode');
    }
  });

  // ── 11. Passcode coercion attempts ────────────────────────────────────────
  describe('11. Passcode coercion attempts fail closed', () => {
    test('numeric number type (123456) is rejected without coercion', () => {
      const req = { ...createValidSyntheticRequest(), newPasscode: 123456 };
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_passcode_type');
      }
    });

    test('array of digit strings is rejected', () => {
      const req = { ...createValidSyntheticRequest(), newPasscode: ['1', '2', '3', '4', '5', '6'] };
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_passcode_type');
      }
    });

    test('object with toString() is rejected without coercion', () => {
      const req = {
        ...createValidSyntheticRequest(),
        newPasscode: { toString: () => '123456' },
      };
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_passcode_type');
      }
    });
  });

  // ── 12. Empty and malformed IDs ───────────────────────────────────────────
  describe('12. Empty and malformed IDs fail closed without trimming or repair', () => {
    const malformedIds = [
      { val: '', desc: 'empty string', expectedCode: 'empty_id' },
      { val: '   ', desc: 'whitespace only', expectedCode: 'malformed_id' },
      { val: ' drv_01 ', desc: 'leading/trailing whitespace (never trimmed)', expectedCode: 'malformed_id' },
      { val: 'drv\t01', desc: 'tab character', expectedCode: 'malformed_id' },
      { val: 'drv\n01', desc: 'newline character', expectedCode: 'malformed_id' },
      { val: 'drv/01', desc: 'slash character', expectedCode: 'malformed_id' },
      { val: 'drv@01', desc: 'at symbol', expectedCode: 'malformed_id' },
      { val: 'a'.repeat(129), desc: 'overly long ID (> 128 chars)', expectedCode: 'id_too_long' },
      { val: 12345, desc: 'number instead of string', expectedCode: 'invalid_id_type' },
    ];

    ['opId', 'companyId', 'driverId'].forEach((idField) => {
      malformedIds.forEach(({ val, desc, expectedCode }) => {
        test(`field '${idField}' rejects ${desc}`, () => {
          const req = { ...createValidSyntheticRequest(), [idField]: val };
          const result = validateCanonicalResetRequest(req);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.code).toBe(expectedCode);
            expect(result.error.path).toBe(idField);
          }
        });
      });
    });
  });

  // ── 13. Caller/role/company-authority injection fields ─────────────────────
  describe('13. Injection fields are strictly rejected on the wire request', () => {
    const injectionVectors = [
      { key: 'uid', val: 'attacker_uid' },
      { key: 'callerUid', val: 'attacker_uid' },
      { key: 'role', val: 'admin' },
      { key: 'roles', val: ['owner', 'admin'] },
      { key: 'claims', val: { kind: 'driver', role: 'admin' } },
      { key: 'capability', val: 'reset_passcode' },
      { key: 'capabilities', val: ['can_reset_driver'] },
      { key: 'email', val: 'attacker@evil.corp' },
      { key: 'displayName', val: 'Forged Identity' },
      { key: 'companyScope', val: 'cross_tenant' },
      { key: 'approvedKey', val: 'synthetic_app_key' },
      { key: 'legacyHash', val: 'd41d8cd98f00b204e9800998ecf8427e' },
      { key: 'isAdmin', val: true },
      { key: 'authority', val: 'override' },
    ];

    injectionVectors.forEach(({ key, val }) => {
      test(`rejects injection field '${key}'`, () => {
        const req = { ...createValidSyntheticRequest(), [key]: val };
        const result = validateCanonicalResetRequest(req);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('unknown_field');
          expect(result.error.path).toBe(key);
        }
      });
    });
  });

  // ── 14. Valid canonical scrypt credential ──────────────────────────────────
  test('14. Valid canonical scrypt credential passes validation', () => {
    const cred = createValidSyntheticCredential();
    const result = validateCanonicalCredential(cred);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.algo).toBe('scrypt');
      expect(result.value.N).toBe(16384);
      expect(result.value.r).toBe(8);
      expect(result.value.p).toBe(1);
      expect(result.value.keyLen).toBe(32);
      expect(result.value.active).toBe(true);
      expect(result.value.credentialVersion).toBe(1);
    }
  });

  // ── 15. Empty hash and salt ───────────────────────────────────────────────
  describe('15. Empty hash and salt are invalid', () => {
    test('empty saltB64 is rejected', () => {
      const cred = { ...createValidSyntheticCredential(), saltB64: '' };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('empty_salt');
      }
    });

    test('empty hashB64 is rejected', () => {
      const cred = { ...createValidSyntheticCredential(), hashB64: '' };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('empty_hash');
      }
    });

    test('malformed base64 salt is rejected', () => {
      const cred = { ...createValidSyntheticCredential(), saltB64: 'not_base64!@#$' };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_salt');
      }
    });
  });

  // ── 16. Missing or malformed scrypt parameters ─────────────────────────────
  describe('16. Missing or malformed scrypt parameters fail closed', () => {
    test('invalid algo (sha256) is rejected', () => {
      const cred = { ...createValidSyntheticCredential(), algo: 'sha256' };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_algo');
      }
    });

    test('non-power-of-2 N (10000) is rejected', () => {
      const cred = { ...createValidSyntheticCredential(), N: 10000 };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_scrypt_parameter');
        expect(result.error.path).toBe('N');
      }
    });

    test('out-of-bounds N (< 1024) is rejected', () => {
      const cred = { ...createValidSyntheticCredential(), N: 512 };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_scrypt_parameter');
        expect(result.error.path).toBe('N');
      }
    });

    test('invalid r (0) is rejected', () => {
      const cred = { ...createValidSyntheticCredential(), r: 0 };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_scrypt_parameter');
        expect(result.error.path).toBe('r');
      }
    });

    test('invalid keyLen (8) is rejected', () => {
      const cred = { ...createValidSyntheticCredential(), keyLen: 8 };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_scrypt_parameter');
        expect(result.error.path).toBe('keyLen');
      }
    });
  });

  // ── 17. Missing, false, and malformed active ───────────────────────────────
  describe('17. Missing, false, and malformed active fail closed', () => {
    test('active: false is rejected for reset eligibility', () => {
      const cred = { ...createValidSyntheticCredential(), active: false };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('inactive_credential');
      }
    });

    test('missing active is rejected', () => {
      const cred: Record<string, unknown> = { ...createValidSyntheticCredential() };
      delete cred.active;
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('missing_credential_field');
        expect(result.error.path).toBe('active');
      }
    });

    test('non-boolean active ("true") is rejected', () => {
      const cred = { ...createValidSyntheticCredential(), active: 'true' };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_active_type');
      }
    });
  });

  // ── 18. Contradictory company or driver binding ───────────────────────────
  describe('18. Contradictory company or driver binding fails closed', () => {
    test('credential driverId mismatch against expected binding is rejected', () => {
      const cred = createValidSyntheticCredential();
      const result = validateCanonicalCredential(cred, {
        driverId: 'drv_syn_other_driver',
        companyId: SYNTHETIC_CO_ID,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('driver_binding_mismatch');
      }
    });

    test('credential companyId mismatch against expected binding is rejected', () => {
      const cred = createValidSyntheticCredential();
      const result = validateCanonicalCredential(cred, {
        driverId: SYNTHETIC_DRIVER_ID,
        companyId: 'co_syn_different_tenant',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('company_binding_mismatch');
      }
    });
  });

  // ── 19. Valid session/version binding ─────────────────────────────────────
  test('19. Valid session/version binding passes validation', () => {
    const session: DriverSessionBinding = {
      sessionId: 'sess_syn_101',
      driverId: SYNTHETIC_DRIVER_ID,
      companyId: SYNTHETIC_CO_ID,
      credentialVersion: 1,
    };
    const result = validateDriverSessionBinding(session);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sessionId).toBe('sess_syn_101');
      expect(result.value.credentialVersion).toBe(1);
    }
  });

  // ── 20. Missing or malformed session credential version ───────────────────
  describe('20. Missing or malformed session credential version fails closed', () => {
    test('missing session credentialVersion is rejected', () => {
      const session: Record<string, unknown> = {
        sessionId: 'sess_syn_101',
        driverId: SYNTHETIC_DRIVER_ID,
        companyId: SYNTHETIC_CO_ID,
      };
      const result = validateDriverSessionBinding(session);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('missing_session_field');
        expect(result.error.path).toBe('credentialVersion');
      }
    });

    test('stale session version compared with credential fails revocation check', () => {
      const session: DriverSessionBinding = {
        sessionId: 'sess_syn_101',
        driverId: SYNTHETIC_DRIVER_ID,
        companyId: SYNTHETIC_CO_ID,
        credentialVersion: 1,
      };
      const rotatedCred: CanonicalCredential = {
        ...createValidSyntheticCredential(),
        credentialVersion: 2, // Credential has progressed
      };
      const matchResult = validateSessionVersionMatch(session, rotatedCred);
      expect(matchResult.ok).toBe(false);
      if (!matchResult.ok) {
        expect(matchResult.error.code).toBe('session_credential_version_mismatch');
      }
    });
  });

  // ── 21. Valid immutable reset-receipt shape ───────────────────────────────
  test('21. Valid immutable reset-receipt shape passes validation', () => {
    const receipt: ResetReceipt = {
      receiptId: 'rcpt_syn_2001',
      opId: SYNTHETIC_OP_ID,
      companyId: SYNTHETIC_CO_ID,
      driverId: SYNTHETIC_DRIVER_ID,
      previousCredentialVersion: 1,
      newCredentialVersion: 2,
      temporary: true,
      actorUid: SYNTHETIC_ACTOR_UID,
      appliedAt: '2026-09-18T05:00:00.000Z',
      status: 'committed',
      authCleanupStatus: 'pending',
    };
    const result = validateResetReceipt(receipt);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('committed');
      expect(result.value.authCleanupStatus).toBe('pending');
    }
  });

  // ── 22. Valid pending Auth-effect shape ────────────────────────────────────
  test('22. Valid pending Auth-effect shape passes validation', () => {
    const effect: AuthCleanupEffect = {
      effectId: 'eff_syn_3001',
      opId: SYNTHETIC_OP_ID,
      companyId: SYNTHETIC_CO_ID,
      driverId: SYNTHETIC_DRIVER_ID,
      credentialVersion: 2,
      status: 'pending',
      attempts: 0,
      createdAt: '2026-09-18T05:00:00.000Z',
    };
    const result = validateAuthCleanupEffect(effect);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('pending');
      expect(result.value.attempts).toBe(0);
    }
  });

  // ── 23. Receipt/effect status contradictions ──────────────────────────────
  describe('23. Receipt/effect status contradictions fail closed', () => {
    test('receipt claiming completed auth cleanup when effect is pending is rejected', () => {
      const receipt: ResetReceipt = {
        receiptId: 'rcpt_syn_2001',
        opId: SYNTHETIC_OP_ID,
        companyId: SYNTHETIC_CO_ID,
        driverId: SYNTHETIC_DRIVER_ID,
        previousCredentialVersion: 1,
        newCredentialVersion: 2,
        temporary: true,
        actorUid: SYNTHETIC_ACTOR_UID,
        appliedAt: '2026-09-18T05:00:00.000Z',
        status: 'committed',
        authCleanupStatus: 'pending',
      };
      // A receipt alone trying to declare authCleanupStatus = 'completed' fails validateResetReceipt
      const falseReceipt = { ...receipt, authCleanupStatus: 'completed' };
      const receiptResult = validateResetReceipt(falseReceipt);
      expect(receiptResult.ok).toBe(false);
      if (!receiptResult.ok) {
        expect(receiptResult.error.code).toBe('invalid_receipt_auth_cleanup_status');
      }
    });

    test('effect marked completed without completedAt is rejected', () => {
      const effect: AuthCleanupEffect = {
        effectId: 'eff_syn_3001',
        opId: SYNTHETIC_OP_ID,
        companyId: SYNTHETIC_CO_ID,
        driverId: SYNTHETIC_DRIVER_ID,
        credentialVersion: 2,
        status: 'completed',
        attempts: 1,
        createdAt: '2026-09-18T05:00:00.000Z',
        completedAt: null,
      };
      const result = validateAuthCleanupEffect(effect);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('contradictory_effect_status');
      }
    });

    test('pending effect having completedAt timestamp is rejected', () => {
      const effect = {
        effectId: 'eff_syn_3001',
        opId: SYNTHETIC_OP_ID,
        companyId: SYNTHETIC_CO_ID,
        driverId: SYNTHETIC_DRIVER_ID,
        credentialVersion: 2,
        status: 'pending',
        attempts: 0,
        createdAt: '2026-09-18T05:00:00.000Z',
        completedAt: '2026-09-18T05:01:00.000Z',
      };
      const result = validateAuthCleanupEffect(effect);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('contradictory_effect_status');
      }
    });

    test('receipt and effect with mismatched opId are rejected by alignment check', () => {
      const receipt: ResetReceipt = {
        receiptId: 'rcpt_syn_2001',
        opId: SYNTHETIC_OP_ID,
        companyId: SYNTHETIC_CO_ID,
        driverId: SYNTHETIC_DRIVER_ID,
        previousCredentialVersion: 1,
        newCredentialVersion: 2,
        temporary: true,
        actorUid: SYNTHETIC_ACTOR_UID,
        appliedAt: '2026-09-18T05:00:00.000Z',
        status: 'committed',
        authCleanupStatus: 'pending',
      };
      const effect: AuthCleanupEffect = {
        effectId: 'eff_syn_3001',
        opId: 'op_syn_different_id',
        companyId: SYNTHETIC_CO_ID,
        driverId: SYNTHETIC_DRIVER_ID,
        credentialVersion: 2,
        status: 'pending',
        attempts: 0,
        createdAt: '2026-09-18T05:00:00.000Z',
      };
      const alignResult = validateReceiptEffectAlignment(receipt, effect);
      expect(alignResult.ok).toBe(false);
      if (!alignResult.ok) {
        expect(alignResult.error.code).toBe('op_id_mismatch');
      }
    });
  });

  // ── 24. Unknown fields on security-sensitive contracts ─────────────────────
  describe('24. Unknown fields rejected on all security-sensitive contracts', () => {
    test('unknown field rejected on CanonicalCredential', () => {
      const cred = { ...createValidSyntheticCredential(), extraPayload: true };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown_field');
        expect(result.error.path).toBe('extraPayload');
      }
    });

    test('unknown field rejected on DriverSessionBinding', () => {
      const session = {
        sessionId: 'sess_syn_101',
        driverId: SYNTHETIC_DRIVER_ID,
        companyId: SYNTHETIC_CO_ID,
        credentialVersion: 1,
        injectedRole: 'admin',
      };
      const result = validateDriverSessionBinding(session);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown_field');
        expect(result.error.path).toBe('injectedRole');
      }
    });

    test('unknown field rejected on ResetReceipt', () => {
      const receipt = {
        receiptId: 'rcpt_syn_2001',
        opId: SYNTHETIC_OP_ID,
        companyId: SYNTHETIC_CO_ID,
        driverId: SYNTHETIC_DRIVER_ID,
        previousCredentialVersion: 1,
        newCredentialVersion: 2,
        temporary: true,
        actorUid: SYNTHETIC_ACTOR_UID,
        appliedAt: '2026-09-18T05:00:00.000Z',
        status: 'committed',
        authCleanupStatus: 'pending',
        tamperProofBypass: true,
      };
      const result = validateResetReceipt(receipt);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown_field');
        expect(result.error.path).toBe('tamperProofBypass');
      }
    });

    test('unknown field rejected on AuthCleanupEffect', () => {
      const effect = {
        effectId: 'eff_syn_3001',
        opId: SYNTHETIC_OP_ID,
        companyId: SYNTHETIC_CO_ID,
        driverId: SYNTHETIC_DRIVER_ID,
        credentialVersion: 2,
        status: 'pending',
        attempts: 0,
        createdAt: '2026-09-18T05:00:00.000Z',
        injectedClaim: 'bypass',
      };
      const result = validateAuthCleanupEffect(effect);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown_field');
        expect(result.error.path).toBe('injectedClaim');
      }
    });
  });

  // ── 25. Validators do not mutate their input ───────────────────────────────
  test('25. Validators do not mutate their input (Object.freeze check)', () => {
    const frozenRequest = Object.freeze(createValidSyntheticRequest());
    const frozenCredential = Object.freeze(createValidSyntheticCredential());
    const frozenSession = Object.freeze({
      sessionId: 'sess_syn_101',
      driverId: SYNTHETIC_DRIVER_ID,
      companyId: SYNTHETIC_CO_ID,
      credentialVersion: 1,
    });
    const frozenReceipt = Object.freeze({
      receiptId: 'rcpt_syn_2001',
      opId: SYNTHETIC_OP_ID,
      companyId: SYNTHETIC_CO_ID,
      driverId: SYNTHETIC_DRIVER_ID,
      previousCredentialVersion: 1,
      newCredentialVersion: 2,
      temporary: true,
      actorUid: SYNTHETIC_ACTOR_UID,
      appliedAt: '2026-09-18T05:00:00.000Z',
      status: 'committed' as const,
      authCleanupStatus: 'pending' as const,
    });
    const frozenEffect = Object.freeze({
      effectId: 'eff_syn_3001',
      opId: SYNTHETIC_OP_ID,
      companyId: SYNTHETIC_CO_ID,
      driverId: SYNTHETIC_DRIVER_ID,
      credentialVersion: 2,
      status: 'pending' as const,
      attempts: 0,
      createdAt: '2026-09-18T05:00:00.000Z',
    });

    // Execute all validators on frozen inputs; must not throw mutating errors
    expect(() => validateCanonicalResetRequest(frozenRequest)).not.toThrow();
    expect(() => validateCanonicalCredential(frozenCredential)).not.toThrow();
    expect(() => validateDriverSessionBinding(frozenSession)).not.toThrow();
    expect(() => validateSessionVersionMatch(frozenSession, frozenCredential)).not.toThrow();
    expect(() => validateResetReceipt(frozenReceipt)).not.toThrow();
    expect(() => validateAuthCleanupEffect(frozenEffect)).not.toThrow();
    expect(() => validateReceiptEffectAlignment(frozenReceipt, frozenEffect)).not.toThrow();
  });

  // ── 26. Validation results do not contain secret material ─────────────────
  test('26. Validation results and error messages never contain passcode, salt, or hash material', () => {
    const SECRET_TEST_PASSCODE = '98765432198765432100';
    const reqWithInvalidField = {
      ...createValidSyntheticRequest(),
      newPasscode: SECRET_TEST_PASSCODE,
      malformedExtra: 'malformed',
    };
    const reqResult = validateCanonicalResetRequest(reqWithInvalidField);
    expect(reqResult.ok).toBe(false);
    const serializedReqResult = JSON.stringify(reqResult);
    expect(serializedReqResult).not.toContain(SECRET_TEST_PASSCODE);

    // Test with non-numeric passcode containing secret characters
    const nonNumericSecret = 'SECRET_PASSCODE_123456';
    const nonNumResult = validateCanonicalResetRequest({
      ...createValidSyntheticRequest(),
      newPasscode: nonNumericSecret,
    });
    expect(nonNumResult.ok).toBe(false);
    expect(JSON.stringify(nonNumResult)).not.toContain(nonNumericSecret);

    // Test with invalid credential salt/hash
    const credResult = validateCanonicalCredential({
      ...createValidSyntheticCredential(),
      saltB64: SYNTHETIC_SALT_B64,
      hashB64: SYNTHETIC_HASH_B64,
      N: 12345, // invalid parameter
    });
    expect(credResult.ok).toBe(false);
    const serializedCredResult = JSON.stringify(credResult);
    expect(serializedCredResult).not.toContain(SYNTHETIC_SALT_B64);
    expect(serializedCredResult).not.toContain(SYNTHETIC_HASH_B64);
  });
});
