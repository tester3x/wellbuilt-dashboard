/**
 * Canonical Driver Reset Design — Phase 0 Contract & Validator Unit Tests
 *
 * Exhaustive unit tests verifying pure validators, contract shapes, boundary conditions,
 * immutability, fail-closed semantics, separate authority planes, adversarial inputs,
 * and zero secret leakage.
 *
 * NOTE: All test identities, credentials, and data are 100% synthetic.
 * No real persons, companies, passcodes, or production data are used.
 */

import {
  PASSCODE_DIGIT_MIN_LEN,
  PASSCODE_DIGIT_MAX_LEN,
  VERSION_MAX_SAFE,
  type CanonicalResetRequest,
  type CanonicalCredential,
  type DriverSessionBinding,
  type ResetReceipt,
  type AuthCleanupEffect,
  type StaffPrincipal,
  type TenantMembership,
  type TenantRoleCapabilities,
  type TenantSecurityPolicy,
  type TargetDriverBinding,
  type ResetAuthzSnapshot,
  type CanonicalResetOperationCommitment,
} from '../resetDesign/contracts';

import {
  validateCanonicalResetRequest,
  validateCanonicalCredential,
  validateCurrentDriverCredentialDoc,
  validateDriverSessionBinding,
  validateSessionVersionMatch,
  validateResetReceipt,
  validateAuthCleanupEffect,
  validateReceiptEffectAlignment,
  validateEffectLifecycleTransition,
  validateOperationRetryCommitment,
  validateStaffPrincipal,
  validateTenantMembership,
  validateTenantRoleCapabilities,
  validateTenantSecurityPolicy,
  validateTargetDriverBinding,
  validateResetAuthzSnapshot,
  createValidatedSecretBearingRequest,
  createSanitizedOperationCommitment,
  validateCommitmentHash,
} from '../resetDesign/validate';

// ── Synthetic Test Fixtures ──────────────────────────────────────────────────

const SYNTHETIC_OP_ID = 'op_syn_req_1001';
const SYNTHETIC_CO_ID = 'co_syn_tenant_alpha';
const SYNTHETIC_DRIVER_ID = 'drv_syn_driver_001';
const SYNTHETIC_ACTOR_UID = 'staff_syn_admin_001';
// Canonical 16-byte salt base64 ('0123456789abcdef' -> 16 bytes)
const SYNTHETIC_SALT_B64 = 'MDEyMzQ1Njc4OWFiY2RlZg==';
// Canonical 32-byte hash base64 ('0123456789abcdef0123456789abcdef' -> 32 bytes = keyLen)
const SYNTHETIC_HASH_B64 = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const SYNTHETIC_COMMITMENT_HASH = `hmac-sha256:${'ab'.repeat(32)}`;

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

function createValidSyntheticReceipt(): ResetReceipt {
  return {
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
}

function createValidSyntheticEffect(): AuthCleanupEffect {
  return {
    effectId: 'eff_syn_3001',
    opId: SYNTHETIC_OP_ID,
    companyId: SYNTHETIC_CO_ID,
    driverId: SYNTHETIC_DRIVER_ID,
    credentialVersion: 2,
    status: 'pending',
    attempts: 0,
    fenceGeneration: 1,
    createdAt: '2026-09-18T05:00:00.000Z',
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

    for (const field of fields) {
      test(`missing field '${field}' is rejected`, () => {
        const req = createValidSyntheticRequest();
        delete (req as unknown as Record<string, unknown>)[field];
        const result = validateCanonicalResetRequest(req);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('missing_field');
          expect(result.error.path).toBe(field);
        }
      });

      test(`null field '${field}' is rejected`, () => {
        const req = { ...createValidSyntheticRequest(), [field]: null };
        const result = validateCanonicalResetRequest(req);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('missing_field');
          expect(result.error.path).toBe(field);
        }
      });
    }
  });

  // ── 4. Unknown request field rejection ─────────────────────────────────────
  test('4. Unknown request field rejection fails closed on unexpected properties', () => {
    const req = {
      ...createValidSyntheticRequest(),
      attackerInjectedKey: 'malicious',
    };
    const result = validateCanonicalResetRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown_field');
    }
  });

  // ── 5. Missing credential version fails closed ─────────────────────────────
  test('5. Missing credential version fails closed', () => {
    const req = createValidSyntheticRequest();
    delete (req as unknown as Record<string, unknown>).expectedCredentialVersion;
    const result = validateCanonicalResetRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('missing_field');
      expect(result.error.path).toBe('expectedCredentialVersion');
    }
  });

  // ── 6. Invalid expectedCredentialVersion values fail closed ────────────────
  describe('6. Invalid expectedCredentialVersion values fail closed', () => {
    const invalidVersions: [string, unknown, string][] = [
      ['zero version (0)', 0, 'non_positive_integer'],
      ['negative version (-1)', -1, 'non_positive_integer'],
      ['deeply negative version (-100)', -100, 'non_positive_integer'],
      ['fractional version (1.5)', 1.5, 'unsafe_integer'],
      ['NaN version (NaN)', NaN, 'unsafe_integer'],
      ['Infinity version (Infinity)', Infinity, 'unsafe_integer'],
      ['-Infinity version (-Infinity)', -Infinity, 'unsafe_integer'],
      ['unsafe integer version (9007199254741000)', 9007199254741000, 'unsafe_integer'],
      ['overflow version (> 1,000,000)', VERSION_MAX_SAFE + 1, 'counter_overflow'],
      ['numeric string version (1)', '1', 'invalid_integer_type'],
      ['alpha string version (version_1)', 'version_1', 'invalid_integer_type'],
      ['boolean version (false)', false, 'invalid_integer_type'],
      ['object version ([object Object])', {}, 'invalid_integer_type'],
      ['array version (1)', [1], 'invalid_integer_type'],
    ];

    for (const [desc, val, expectedCode] of invalidVersions) {
      test(`rejects ${desc}`, () => {
        const req = { ...createValidSyntheticRequest(), expectedCredentialVersion: val };
        const result = validateCanonicalResetRequest(req);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe(expectedCode);
          expect(result.error.path).toBe('expectedCredentialVersion');
        }
      });
    }
  });

  // ── 7. temporary missing or non-boolean ────────────────────────────────────
  describe('7. temporary missing or nonboolean fails closed', () => {
    const nonBooleans: [string, unknown][] = [
      ['string "true"', 'true'],
      ['string "false"', 'false'],
      ['number 1', 1],
      ['number 0', 0],
      ['empty object', {}],
      ['array', []],
    ];

    for (const [desc, val] of nonBooleans) {
      test(`rejects non-boolean temporary: ${desc}`, () => {
        const req = { ...createValidSyntheticRequest(), temporary: val };
        const result = validateCanonicalResetRequest(req);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('invalid_temporary_type');
          expect(result.error.path).toBe('temporary');
        }
      });
    }
  });

  // ── 8. Passcode length boundaries ──────────────────────────────────────────
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
      const req = { ...createValidSyntheticRequest(), newPasscode: '1'.repeat(128) };
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(true);
    });

    test('129-digit passcode is rejected (too long)', () => {
      const req = { ...createValidSyntheticRequest(), newPasscode: '1'.repeat(129) };
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('passcode_too_long');
      }
    });
  });

  // ── 9. Nonnumeric passcodes are strictly rejected ──────────────────────────
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

    for (const passcode of nonNumericPasscodes) {
      test(`rejects nonnumeric passcode "${passcode.replace(/\n/, '\\n')}"`, () => {
        const req = { ...createValidSyntheticRequest(), newPasscode: passcode };
        const result = validateCanonicalResetRequest(req);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('passcode_non_numeric');
        }
      });
    }
  });

  // ── 10. Empty passcode is rejected ─────────────────────────────────────────
  test('10. Empty passcode is rejected', () => {
    const req = { ...createValidSyntheticRequest(), newPasscode: '' };
    const result = validateCanonicalResetRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('empty_passcode');
    }
  });

  // ── 11. Passcode coercion attempts fail closed ─────────────────────────────
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
      const req = { ...createValidSyntheticRequest(), newPasscode: { toString: () => '123456' } };
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(['invalid_passcode_type', 'invalid_type']).toContain(result.error.code);
      }
    });
  });

  // ── 12. Empty and malformed IDs fail closed without trimming ───────────────
  describe('12. Empty and malformed IDs fail closed without trimming or repair', () => {
    const idFields: ('opId' | 'companyId' | 'driverId')[] = ['opId', 'companyId', 'driverId'];
    const invalidIds: [string, unknown, string][] = [
      ['empty string', '', 'empty_id'],
      ['whitespace only', '   ', 'malformed_id'],
      ['leading/trailing whitespace (never trimmed)', ' id_with_space ', 'malformed_id'],
      ['tab character', 'id\twith_tab', 'malformed_id'],
      ['newline character', 'id\nwith_newline', 'malformed_id'],
      ['slash character', 'id/with/slash', 'malformed_id'],
      ['path traversal single dot', '.', 'malformed_id'],
      ['path traversal double dot', '..', 'malformed_id'],
      ['at symbol', 'user@domain', 'malformed_id'],
      ['overly long ID (> 128 chars)', 'a'.repeat(129), 'id_too_long'],
      ['number instead of string', 12345, 'invalid_id_type'],
    ];

    for (const field of idFields) {
      for (const [desc, val, expectedCode] of invalidIds) {
        test(`field '${field}' rejects ${desc}`, () => {
          const req = { ...createValidSyntheticRequest(), [field]: val };
          const result = validateCanonicalResetRequest(req);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.code).toBe(expectedCode);
          }
        });
      }
    }
  });

  // ── 13. Injection fields are strictly rejected on wire request ─────────────
  describe('13. Injection fields are strictly rejected on the wire request', () => {
    const injectionFields = [
      'uid',
      'callerUid',
      'role',
      'roles',
      'claims',
      'capability',
      'capabilities',
      'email',
      'displayName',
      'companyScope',
      'approvedKey',
      'legacyHash',
      'isAdmin',
      'authority',
    ];

    for (const inj of injectionFields) {
      test(`rejects injection field '${inj}'`, () => {
        const req = { ...createValidSyntheticRequest(), [inj]: 'injected_val' };
        const result = validateCanonicalResetRequest(req);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('unknown_field');
        }
      });
    }
  });

  // ── 14. Valid canonical scrypt credential ──────────────────────────────────
  test('14. Valid canonical scrypt credential passes validation', () => {
    const cred = createValidSyntheticCredential();
    const result = validateCanonicalCredential(cred);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.algo).toBe('scrypt');
      expect(result.value.active).toBe(true);
      expect(result.value.credentialVersion).toBe(1);
    }
  });

  // ── 15. Empty hash and salt are invalid ─────────────────────────────────────
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
      const cred = { ...createValidSyntheticCredential(), saltB64: 'not-valid-base64!' };
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
      }
    });

    test('out-of-bounds N (< 1024) is rejected', () => {
      const cred = { ...createValidSyntheticCredential(), N: 512 };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_scrypt_parameter');
      }
    });

    test('invalid r (0) is rejected', () => {
      const cred = { ...createValidSyntheticCredential(), r: 0 };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_scrypt_parameter');
      }
    });

    test('invalid keyLen (8) is rejected', () => {
      const cred = { ...createValidSyntheticCredential(), keyLen: 8 };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_scrypt_parameter');
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
      const cred = createValidSyntheticCredential();
      delete (cred as unknown as Record<string, unknown>).active;
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('missing_credential_field');
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

  // ── 18. Contradictory company or driver binding ────────────────────────────
  describe('18. Contradictory company or driver binding fails closed', () => {
    test('credential driverId mismatch against expected binding is rejected', () => {
      const cred = createValidSyntheticCredential();
      const result = validateCanonicalCredential(cred, {
        driverId: 'drv_different_002',
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
        companyId: 'co_different_beta',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('company_binding_mismatch');
      }
    });
  });

  // ── 19. Valid session/version binding ──────────────────────────────────────
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
      expect(result.value.credentialVersion).toBe(1);
    }
  });

  // ── 20. Session version matching & revocation ──────────────────────────────
  describe('20. Missing or malformed session credential version fails closed', () => {
    test('stale session version compared with credential fails revocation check', () => {
      const session: DriverSessionBinding = {
        sessionId: 'sess_syn_101',
        driverId: SYNTHETIC_DRIVER_ID,
        companyId: SYNTHETIC_CO_ID,
        credentialVersion: 1,
      };
      const cred = { ...createValidSyntheticCredential(), credentialVersion: 2 };
      const matchResult = validateSessionVersionMatch(session, cred);
      expect(matchResult.ok).toBe(false);
      if (!matchResult.ok) {
        expect(matchResult.error.code).toBe('session_credential_version_mismatch');
      }
    });
  });

  // ── 21. Valid immutable reset-receipt shape ────────────────────────────────
  test('21. Valid immutable reset-receipt shape passes validation', () => {
    const receipt = createValidSyntheticReceipt();
    const result = validateResetReceipt(receipt);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('committed');
      expect(result.value.authCleanupStatus).toBe('pending');
      expect(result.value.newCredentialVersion).toBe(2);
    }
  });

  // ── 22. Valid pending Auth-effect shape ────────────────────────────────────
  test('22. Valid pending Auth-effect shape passes validation', () => {
    const effect = createValidSyntheticEffect();
    const result = validateAuthCleanupEffect(effect);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('pending');
      expect(result.value.attempts).toBe(0);
      expect(result.value.fenceGeneration).toBe(1);
    }
  });

  // ── 23. Receipt/effect status contradictions ───────────────────────────────
  describe('23. Receipt/effect status contradictions fail closed', () => {
    test('receipt claiming completed auth cleanup when effect is pending is rejected', () => {
      const receipt = {
        ...createValidSyntheticReceipt(),
        authCleanupStatus: 'completed',
      };
      const effect = createValidSyntheticEffect();
      const result = validateReceiptEffectAlignment(receipt, effect);
      expect(result.ok).toBe(false);
    });

    test('effect marked completed without completedAt is rejected', () => {
      const effect = {
        ...createValidSyntheticEffect(),
        status: 'completed',
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
        ...createValidSyntheticEffect(),
        status: 'pending',
        completedAt: '2026-09-18T05:01:00.000Z',
      };
      const result = validateAuthCleanupEffect(effect);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('contradictory_effect_status');
      }
    });

    test('receipt and effect with mismatched opId are rejected by alignment check', () => {
      const receipt = createValidSyntheticReceipt();
      const effect = { ...createValidSyntheticEffect(), opId: 'op_syn_req_different' };
      const result = validateReceiptEffectAlignment(receipt, effect);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('op_id_mismatch');
      }
    });
  });

  // ── 24. Unknown fields rejected on all contracts ───────────────────────────
  describe('24. Unknown fields rejected on all security-sensitive contracts', () => {
    test('unknown field rejected on CanonicalCredential', () => {
      const cred = { ...createValidSyntheticCredential(), extraField: 'injection' };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown_field');
      }
    });

    test('unknown field rejected on DriverSessionBinding', () => {
      const session = {
        sessionId: 'sess_syn_101',
        driverId: SYNTHETIC_DRIVER_ID,
        companyId: SYNTHETIC_CO_ID,
        credentialVersion: 1,
        tamperedField: true,
      };
      const result = validateDriverSessionBinding(session);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown_field');
      }
    });

    test('unknown field rejected on ResetReceipt', () => {
      const receipt = {
        ...createValidSyntheticReceipt(),
        tamperProofBypass: true,
      };
      const result = validateResetReceipt(receipt);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown_field');
      }
    });

    test('unknown field rejected on AuthCleanupEffect', () => {
      const effect = {
        ...createValidSyntheticEffect(),
        injectedClaim: 'bypass',
      };
      const result = validateAuthCleanupEffect(effect);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown_field');
      }
    });
  });

  // ── 25. Validators do not mutate input (frozen check) ──────────────────────
  test('25. Validators do not mutate their input (Object.freeze check)', () => {
    const frozenRequest = Object.freeze(createValidSyntheticRequest());
    const frozenCredential = Object.freeze(createValidSyntheticCredential());
    const frozenSession = Object.freeze({
      sessionId: 'sess_syn_101',
      driverId: SYNTHETIC_DRIVER_ID,
      companyId: SYNTHETIC_CO_ID,
      credentialVersion: 1,
    });
    const frozenReceipt = Object.freeze(createValidSyntheticReceipt());
    const frozenEffect = Object.freeze(createValidSyntheticEffect());

    expect(() => validateCanonicalResetRequest(frozenRequest)).not.toThrow();
    expect(() => validateCanonicalCredential(frozenCredential)).not.toThrow();
    expect(() => validateDriverSessionBinding(frozenSession)).not.toThrow();
    expect(() => validateSessionVersionMatch(frozenSession, frozenCredential)).not.toThrow();
    expect(() => validateResetReceipt(frozenReceipt)).not.toThrow();
    expect(() => validateAuthCleanupEffect(frozenEffect)).not.toThrow();
    expect(() => validateReceiptEffectAlignment(frozenReceipt, frozenEffect)).not.toThrow();
  });

  // ── 26. Zero secret material leakage ───────────────────────────────────────
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

    const nonNumericSecret = 'SECRET_PASSCODE_123456';
    const nonNumResult = validateCanonicalResetRequest({
      ...createValidSyntheticRequest(),
      newPasscode: nonNumericSecret,
    });
    expect(nonNumResult.ok).toBe(false);
    expect(JSON.stringify(nonNumResult)).not.toContain(nonNumericSecret);

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

  // ════════════════════════════════════════════════════════════════════════════
  // ── ADVERSARIAL COUNTEREXAMPLE AUDIT SUITE (Desktop Codex Findings) ─────────
  // ════════════════════════════════════════════════════════════════════════════

  // ── A1. Inherited properties & prototype poisoning ─────────────────────────
  describe('A1. Inherited properties and exotic prototypes fail closed', () => {
    test('rejects object created via Object.create with prototype fields', () => {
      const proto = { opId: SYNTHETIC_OP_ID, companyId: SYNTHETIC_CO_ID };
      const req = Object.create(proto);
      Object.assign(req, {
        driverId: SYNTHETIC_DRIVER_ID,
        expectedCredentialVersion: 1,
        temporary: true,
        newPasscode: '123456',
      });
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_object_prototype');
      }
    });

    test('rejects custom class instance prototype', () => {
      class ResetCommand {
        opId = SYNTHETIC_OP_ID;
        companyId = SYNTHETIC_CO_ID;
        driverId = SYNTHETIC_DRIVER_ID;
        expectedCredentialVersion = 1;
        temporary = true;
        newPasscode = '123456';
      }
      const result = validateCanonicalResetRequest(new ResetCommand());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_object_prototype');
      }
    });

    test('accepts plain object with null prototype', () => {
      const req = Object.create(null);
      Object.assign(req, createValidSyntheticRequest());
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(true);
    });
  });

  // ── A2. Getters, setters, and accessor descriptors ─────────────────────────
  describe('A2. Getters/setters rejected without invocation', () => {
    test('getter property is rejected without ever invoking the getter function', () => {
      let getterInvoked = false;
      const req = createValidSyntheticRequest();
      Object.defineProperty(req, 'maliciousGetter', {
        get() {
          getterInvoked = true;
          return 'injected';
        },
        enumerable: true,
        configurable: true,
      });
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('accessor_property_rejected');
      }
      expect(getterInvoked).toBe(false);
    });

    test('throwing getter is caught safely without throwing out of validator', () => {
      const req = createValidSyntheticRequest();
      Object.defineProperty(req, 'explodingGetter', {
        get(): string {
          throw new Error('ATTACKER_EXPLOSION');
        },
        enumerable: true,
        configurable: true,
      });
      expect(() => validateCanonicalResetRequest(req)).not.toThrow();
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('accessor_property_rejected');
      }
    });

    test('setter-only property is rejected without invocation', () => {
      let setterInvoked = false;
      const req = createValidSyntheticRequest();
      Object.defineProperty(req, 'maliciousSetter', {
        set(_val: unknown) {
          setterInvoked = true;
        },
        enumerable: true,
        configurable: true,
      });
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('accessor_property_rejected');
      }
      expect(setterInvoked).toBe(false);
    });
  });

  // ── A3. Non-enumerable and symbol properties ───────────────────────────────
  describe('A3. Non-enumerable and symbol properties', () => {
    test('rejects hidden non-enumerable property', () => {
      const req = createValidSyntheticRequest();
      Object.defineProperty(req, 'hiddenBackdoor', {
        value: 'hidden_val',
        enumerable: false,
        configurable: true,
      });
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('non_enumerable_property_rejected');
      }
    });

    test('rejects symbol property', () => {
      const req = {
        ...createValidSyntheticRequest(),
        [Symbol('backdoor')]: 'secret_symbol',
      };
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('symbol_property_rejected');
      }
    });
  });

  // ── A4. Throwing proxy traps fail closed safely ────────────────────────────
  describe('A4. Throwing proxy traps fail closed safely', () => {
    test('proxy throwing on getPrototypeOf fails closed with static error', () => {
      const proxyReq = new Proxy(createValidSyntheticRequest(), {
        getPrototypeOf() {
          throw new Error('TRAP_FAIL');
        },
      });
      expect(() => validateCanonicalResetRequest(proxyReq)).not.toThrow();
      const result = validateCanonicalResetRequest(proxyReq);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('property_access_error');
      }
    });

    test('proxy throwing on getOwnPropertyDescriptor fails closed safely', () => {
      const proxyReq = new Proxy(createValidSyntheticRequest(), {
        getOwnPropertyDescriptor() {
          throw new Error('TRAP_FAIL');
        },
      });
      expect(() => validateCanonicalResetRequest(proxyReq)).not.toThrow();
      const result = validateCanonicalResetRequest(proxyReq);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('property_access_error');
      }
    });
  });

  // ── A5. Exotic objects rejected ───────────────────────────────────────────
  describe('A5. Exotic built-in objects rejected', () => {
    test('Date object rejected', () => {
      expect(validateCanonicalResetRequest(new Date()).ok).toBe(false);
    });

    test('RegExp object rejected', () => {
      expect(validateCanonicalResetRequest(/regex/).ok).toBe(false);
    });

    test('Map object rejected', () => {
      expect(validateCanonicalResetRequest(new Map()).ok).toBe(false);
    });

    test('Set object rejected', () => {
      expect(validateCanonicalResetRequest(new Set()).ok).toBe(false);
    });

    test('Array object rejected', () => {
      expect(validateCanonicalResetRequest([]).ok).toBe(false);
    });
  });

  // ── A6. Null & malformed composite operands ────────────────────────────────
  describe('A6. Composite helpers validate operands first', () => {
    test('validateSessionVersionMatch fails safely on null operands', () => {
      const res1 = validateSessionVersionMatch(null, null);
      expect(res1.ok).toBe(false);
      const res2 = validateSessionVersionMatch(null, createValidSyntheticCredential());
      expect(res2.ok).toBe(false);
      const res3 = validateSessionVersionMatch({ sessionId: 's1' }, null);
      expect(res3.ok).toBe(false);
    });

    test('validateSessionVersionMatch fails safely on malformed matching string versions', () => {
      const malformedSession = { credentialVersion: '1' };
      const malformedCredential = { credentialVersion: '1' };
      const result = validateSessionVersionMatch(malformedSession, malformedCredential);
      expect(result.ok).toBe(false);
    });

    test('validateReceiptEffectAlignment fails safely on null and empty objects', () => {
      expect(validateReceiptEffectAlignment(null, null).ok).toBe(false);
      expect(validateReceiptEffectAlignment({}, {}).ok).toBe(false);
      expect(validateReceiptEffectAlignment(createValidSyntheticReceipt(), {}).ok).toBe(false);
      expect(validateReceiptEffectAlignment({}, createValidSyntheticEffect()).ok).toBe(false);
    });
  });

  // ── A7. Scrypt strict base64 & keyLen mismatch counterexamples ─────────────
  describe('A7. Scrypt strict canonical base64 and keyLen validation', () => {
    test('rejects decoded hash length != keyLen (e.g. 40-byte hash with 32-byte keyLen)', () => {
      // 40 bytes base64 = 56 chars base64
      const mismatchedHashB64 = Buffer.alloc(40).toString('base64');
      const cred = {
        ...createValidSyntheticCredential(),
        hashB64: mismatchedHashB64,
        keyLen: 32, // expected 32 bytes, provided 40!
      };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('hash_keylen_mismatch');
      }
    });

    test('rejects non-canonical base64 salt (corrupt trailing bits)', () => {
      // Standard 16 bytes: 'MDEyMzQ1Njc4OWFiY2RlZg=='
      // Changing the padding character to introduce non-zero unencoded bits:
      const nonCanonicalSalt = 'MDEyMzQ1Njc4OWFiY2RlZh==';
      const cred = {
        ...createValidSyntheticCredential(),
        saltB64: nonCanonicalSalt,
      };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('invalid_salt');
      }
    });

    test('rejects excessive scrypt memory profile (DoS prevention)', () => {
      // N = 65536, r = 16 -> 128 * 65536 * 16 = 134,217,728 bytes = 128 MB > 32 MB ceiling
      const cred = {
        ...createValidSyntheticCredential(),
        N: 65536,
        r: 16,
      };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('excessive_scrypt_memory');
      }
    });
  });

  // ── A8. Unsafe counters and retry bounds ────────────────────────────────────
  describe('A8. Unsafe counters and retry bounds', () => {
    test('rejects MAX_SAFE_INTEGER for expectedCredentialVersion', () => {
      const req = {
        ...createValidSyntheticRequest(),
        expectedCredentialVersion: Number.MAX_SAFE_INTEGER,
      };
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('counter_overflow');
      }
    });

    test('rejects attempts exceeding MAX_RETRY_ATTEMPTS on AuthCleanupEffect', () => {
      const effect = {
        ...createValidSyntheticEffect(),
        attempts: 6, // max is 5
      };
      const result = validateAuthCleanupEffect(effect);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('counter_overflow');
      }
    });
  });

  // ── A9. Strict timestamps and chronology ───────────────────────────────────
  describe('A9. Strict timestamps and chronology enforcement', () => {
    test('rejects non-ISO timestamp string on receipt', () => {
      const receipt = {
        ...createValidSyntheticReceipt(),
        appliedAt: '2026-09-18 05:00:00', // Missing 'T' and 'Z'
      };
      const result = validateResetReceipt(receipt);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('malformed_timestamp');
      }
    });

    test('rejects effect where completedAt is earlier than createdAt', () => {
      const effect = {
        ...createValidSyntheticEffect(),
        status: 'completed',
        createdAt: '2026-09-18T05:00:00.000Z',
        completedAt: '2026-09-18T04:59:59.000Z', // Precedes createdAt!
      };
      const result = validateAuthCleanupEffect(effect);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('chronology_violation');
      }
    });

    test('rejects effect where completedAt is earlier than lastAttemptAt', () => {
      const effect = {
        ...createValidSyntheticEffect(),
        status: 'completed',
        createdAt: '2026-09-18T05:00:00.000Z',
        lastAttemptAt: '2026-09-18T05:05:00.000Z',
        completedAt: '2026-09-18T05:02:00.000Z', // Precedes lastAttemptAt!
      };
      const result = validateAuthCleanupEffect(effect);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('chronology_violation');
      }
    });
  });

  // ── A10. Domain-specific identifier bounds & path traversal ────────────────
  describe('A10. Domain-specific identifier bounds', () => {
    test('rejects path traversal ".." in driverId', () => {
      const req = { ...createValidSyntheticRequest(), driverId: '..' };
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('malformed_id');
      }
    });

    test('accepts colon-containing Auth UIDs in actorUid (e.g. auth0:federated-123)', () => {
      const receipt = {
        ...createValidSyntheticReceipt(),
        actorUid: 'auth0:federated-staff-123',
      };
      const result = validateResetReceipt(receipt);
      expect(result.ok).toBe(true);
    });

    test('rejects path traversal ".." in actorUid', () => {
      const receipt = {
        ...createValidSyntheticReceipt(),
        actorUid: '..',
      };
      const result = validateResetReceipt(receipt);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('malformed_id');
      }
    });
  });

  // ── A11. Forward-only lifecycle state transitions ──────────────────────────
  describe('A11. Forward-only lifecycle state transitions', () => {
    test('permits valid forward transition: pending -> in_progress', () => {
      const current = createValidSyntheticEffect();
      const next = {
        ...current,
        status: 'in_progress' as const,
        attempts: 1,
        fenceGeneration: current.fenceGeneration + 1,
        lastAttemptAt: '2026-09-18T05:01:00.000Z',
      };
      const result = validateEffectLifecycleTransition(current, next);
      expect(result.ok).toBe(true);
    });

    test('permits valid forward transition: in_progress -> completed', () => {
      const current: AuthCleanupEffect = {
        ...createValidSyntheticEffect(),
        status: 'in_progress',
        attempts: 1,
        lastAttemptAt: '2026-09-18T05:01:00.000Z',
      };
      const next: AuthCleanupEffect = {
        ...current,
        status: 'completed',
        completedAt: '2026-09-18T05:02:00.000Z',
      };
      const result = validateEffectLifecycleTransition(current, next);
      expect(result.ok).toBe(true);
    });

    test('rejects backward transition: completed -> pending (re-play forbidden)', () => {
      const current: AuthCleanupEffect = {
        ...createValidSyntheticEffect(),
        status: 'completed',
        completedAt: '2026-09-18T05:02:00.000Z',
      };
      const next: AuthCleanupEffect = {
        ...createValidSyntheticEffect(),
        status: 'pending',
      };
      const result = validateEffectLifecycleTransition(current, next);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden_backward_transition');
      }
    });

    test('rejects fence generation regression', () => {
      const current: AuthCleanupEffect = {
        ...createValidSyntheticEffect(),
        fenceGeneration: 5,
      };
      const next: AuthCleanupEffect = {
        ...current,
        status: 'in_progress',
        attempts: 1,
        lastAttemptAt: '2026-09-18T05:01:00.000Z',
        fenceGeneration: 4, // Regressed!
      };
      const result = validateEffectLifecycleTransition(current, next);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('forbidden_backward_transition');
      }
    });
  });

  // ── A12. Idempotent retry vs conflict behavior ─────────────────────────────
  describe('A12. Idempotent retry and conflict behavior', () => {
    test('allows identical same-operation retry', () => {
      const req = createValidSyntheticRequest();
      const secretReq = createValidatedSecretBearingRequest(req, SYNTHETIC_COMMITMENT_HASH);
      const commitment = createSanitizedOperationCommitment(secretReq, SYNTHETIC_ACTOR_UID, '2026-09-18T05:00:00.000Z');

      const result = validateOperationRetryCommitment(commitment, req);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isIdempotentRetry).toBe(true);
      }
    });

    test('rejects operation retry conflict when request parameters change', () => {
      const req = createValidSyntheticRequest();
      const secretReq = createValidatedSecretBearingRequest(req, SYNTHETIC_COMMITMENT_HASH);
      const commitment = createSanitizedOperationCommitment(secretReq, SYNTHETIC_ACTOR_UID, '2026-09-18T05:00:00.000Z');

      const conflictingReq = { ...req, driverId: 'drv_different_target' };
      const result = validateOperationRetryCommitment(commitment, conflictingReq);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('idempotent_retry_conflict');
      }
    });
  });

  // ── A13. Returned object immutability (deepFreeze) ──────────────────────────
  describe('A13. Mutation attempts against returned validated objects fail', () => {
    test('modifying validated request value throws in strict mode', () => {
      const req = createValidSyntheticRequest();
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Object.isFrozen(result.value)).toBe(true);
        expect(() => {
          (result.value as unknown as Record<string, unknown>).temporary = false;
        }).toThrow(TypeError);
      }
    });

    test('modifying validated credential value throws in strict mode', () => {
      const cred = createValidSyntheticCredential();
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Object.isFrozen(result.value)).toBe(true);
        expect(() => {
          (result.value as unknown as Record<string, unknown>).active = false;
        }).toThrow(TypeError);
      }
    });
  });

  // ── A14. Separate Authority Planes Validation (Requirement 1) ──────────────
  describe('A14. Separate Authority Planes Contracts & Validation', () => {
    const validPrincipal: StaffPrincipal = {
      staffUid: SYNTHETIC_ACTOR_UID,
      authTime: '2026-09-18T04:55:00.000Z',
      email: 'admin@company.com',
      emailVerified: true,
      isAnonymous: false,
      disabled: false,
    };

    const validMembership: TenantMembership = {
      membershipId: 'mem_syn_001',
      companyId: SYNTHETIC_CO_ID,
      staffUid: SYNTHETIC_ACTOR_UID,
      status: 'active',
      joinedAt: '2026-01-01T00:00:00.000Z',
    };

    const validCapabilities: TenantRoleCapabilities = {
      companyId: SYNTHETIC_CO_ID,
      staffUid: SYNTHETIC_ACTOR_UID,
      roles: ['security_admin'],
      capabilities: ['canResetDriverPasscode', 'canIssuePermanentPasscode'],
      canResetDriverPasscode: true,
      canIssuePermanentPasscode: true,
    };

    const validPolicy: TenantSecurityPolicy = {
      companyId: SYNTHETIC_CO_ID,
      allowAdminPasscodeReset: true,
      allowPermanentPasscodeReset: true,
      requiredPasscodeMinLength: 6,
      maxPasscodeLength: 128,
      requireTemporaryOnReset: false,
    };

    const validTargetDriver: TargetDriverBinding = {
      driverId: SYNTHETIC_DRIVER_ID,
      companyId: SYNTHETIC_CO_ID,
      active: true,
      status: 'active',
    };

    function createValidAuthzSnapshot(): ResetAuthzSnapshot {
      return {
        snapshotId: 'snap_syn_1001',
        opId: SYNTHETIC_OP_ID,
        evaluatedAt: '2026-09-18T05:00:00.000Z',
        staffPrincipal: validPrincipal,
        tenantMembership: validMembership,
        tenantRoleCapabilities: validCapabilities,
        tenantSecurityPolicy: validPolicy,
        targetDriverBinding: validTargetDriver,
        resetMode: 'temporary',
      };
    }

    test('valid authorization snapshot passes validation', () => {
      const snap = createValidAuthzSnapshot();
      const result = validateResetAuthzSnapshot(snap);
      expect(result.ok).toBe(true);
    });

    test('global staff principal alone does not grant tenant mutation authority (missing membership fails)', () => {
      const snap = {
        ...createValidAuthzSnapshot(),
        tenantMembership: { ...validMembership, status: 'suspended' },
      };
      const result = validateResetAuthzSnapshot(snap);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('membership_inactive');
      }
    });

    test('staff principal UID mismatch across authority planes fails closed', () => {
      const snap = {
        ...createValidAuthzSnapshot(),
        tenantMembership: { ...validMembership, staffUid: 'staff_different_002' },
      };
      const result = validateResetAuthzSnapshot(snap);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unauthorized_actor');
      }
    });

    test('companyId mismatch between driver and tenant membership fails closed', () => {
      const snap = {
        ...createValidAuthzSnapshot(),
        targetDriverBinding: { ...validTargetDriver, companyId: 'co_foreign_tenant' },
      };
      const result = validateResetAuthzSnapshot(snap);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('company_binding_mismatch');
      }
    });

    test('unauthorized permanent passcode issuance fails closed', () => {
      const snap = {
        ...createValidAuthzSnapshot(),
        resetMode: 'permanent' as const,
        tenantRoleCapabilities: { ...validCapabilities, canIssuePermanentPasscode: false },
      };
      const result = validateResetAuthzSnapshot(snap);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unauthorized_actor');
      }
    });
  });

  // ── A15. Current Source vs Future Schema Reconciliation (Requirement 7) ────
  describe('A15. Current Source Driver Credential Document validation', () => {
    test('validates current nested passcode structure in driver_credentials', () => {
      const currentDoc = {
        displayName: 'Test Driver',
        displayNameNorm: 'test driver',
        active: true,
        mustResetPasscode: false,
        passcode: {
          algo: 'scrypt',
          N: 16384,
          r: 8,
          p: 1,
          keyLen: 32,
          saltB64: SYNTHETIC_SALT_B64,
          hashB64: SYNTHETIC_HASH_B64,
        },
      };
      const result = validateCurrentDriverCredentialDoc(currentDoc);
      expect(result.ok).toBe(true);
    });

    test('rejects current doc with missing nested passcode object', () => {
      const currentDoc = {
        displayName: 'Test Driver',
        displayNameNorm: 'test driver',
      };
      const result = validateCurrentDriverCredentialDoc(currentDoc);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('missing_credential_field');
      }
    });
  });

  // ── V2. Desktop Codex HOLD counterexamples ────────────────────────────────
  describe('V2. Hardening regressions against Codex P1/P2 counterexamples', () => {
    test('revoked proxy fails closed with a static inspect error', () => {
      const target = createValidSyntheticRequest();
      const proxy = Proxy.revocable(target, {});
      proxy.revoke();
      expect(() => validateCanonicalResetRequest(proxy.proxy)).not.toThrow();
      const result = validateCanonicalResetRequest(proxy.proxy);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('property_access_error');
        expect(result.error.message).toBe('Failed to inspect value');
      }
    });

    test('stateful getter is not invoked because accessors are rejected from the descriptor snapshot', () => {
      let calls = 0;
      const req = createValidSyntheticRequest();
      Object.defineProperty(req, 'newPasscode', {
        get() {
          calls += 1;
          return calls === 1 ? '123456' : '999999';
        },
        enumerable: true,
        configurable: true,
      });
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      expect(calls).toBe(0);
    });

    test('inherited staffUid never authorizes a principal', () => {
      const proto = { staffUid: SYNTHETIC_ACTOR_UID, emailVerified: true, isAnonymous: false, disabled: false, authTime: '2026-09-18T04:55:00.000Z' };
      const raw = Object.create(proto);
      const result = validateStaffPrincipal(raw);
      expect(result.ok).toBe(false);
    });

    test('inherited canResetDriverPasscode never authorizes', () => {
      const proto = {
        companyId: SYNTHETIC_CO_ID,
        staffUid: SYNTHETIC_ACTOR_UID,
        roles: ['security_admin'],
        capabilities: ['canResetDriverPasscode'],
        canResetDriverPasscode: true,
        canIssuePermanentPasscode: true,
      };
      const raw = Object.create(proto);
      Object.assign(raw, { companyId: SYNTHETIC_CO_ID, staffUid: SYNTHETIC_ACTOR_UID, roles: ['security_admin'], capabilities: ['canResetDriverPasscode'], canIssuePermanentPasscode: true });
      const result = validateTenantRoleCapabilities(raw);
      expect(result.ok).toBe(false);
    });

    test('sparse role arrays are rejected', () => {
      const roles = [];
      roles[0] = 'security_admin';
      roles[2] = 'hidden';
      const raw = {
        companyId: SYNTHETIC_CO_ID,
        staffUid: SYNTHETIC_ACTOR_UID,
        roles,
        capabilities: ['canResetDriverPasscode'],
        canResetDriverPasscode: true,
        canIssuePermanentPasscode: false,
      };
      expect(validateTenantRoleCapabilities(raw).ok).toBe(false);
    });

    test('mutating the original after validation does not change the detached copy', () => {
      const req = createValidSyntheticRequest();
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(true);
      if (result.ok) {
        (req as { newPasscode: string }).newPasscode = '000000';
        expect(result.value.newPasscode).toBe('123456');
        expect(Object.isFrozen(result)).toBe(true);
      }
    });

    test('malformed policy limits are rejected rather than defaulted', () => {
      const policy = {
        companyId: SYNTHETIC_CO_ID,
        allowAdminPasscodeReset: true,
        allowPermanentPasscodeReset: false,
        requireTemporaryOnReset: true,
        requiredPasscodeMinLength: -1,
        maxPasscodeLength: 128,
      };
      const result = validateTenantSecurityPolicy(policy);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_policy_bound');
    });

    test('invalid reset mode is not silently coerced to temporary', () => {
      const snap = {
        snapshotId: 'snap_syn_1001',
        opId: SYNTHETIC_OP_ID,
        evaluatedAt: '2026-09-18T05:00:00.000Z',
        staffPrincipal: {
          staffUid: SYNTHETIC_ACTOR_UID,
          authTime: '2026-09-18T04:55:00.000Z',
          emailVerified: true,
          isAnonymous: false,
          disabled: false,
        },
        tenantMembership: {
          membershipId: 'mem_syn_001',
          companyId: SYNTHETIC_CO_ID,
          staffUid: SYNTHETIC_ACTOR_UID,
          status: 'active',
          joinedAt: '2026-01-01T00:00:00.000Z',
        },
        tenantRoleCapabilities: {
          companyId: SYNTHETIC_CO_ID,
          staffUid: SYNTHETIC_ACTOR_UID,
          roles: ['security_admin'],
          capabilities: ['canResetDriverPasscode'],
          canResetDriverPasscode: true,
          canIssuePermanentPasscode: false,
        },
        tenantSecurityPolicy: {
          companyId: SYNTHETIC_CO_ID,
          allowAdminPasscodeReset: true,
          allowPermanentPasscodeReset: false,
          requiredPasscodeMinLength: 6,
          maxPasscodeLength: 128,
          requireTemporaryOnReset: true,
        },
        targetDriverBinding: {
          driverId: SYNTHETIC_DRIVER_ID,
          companyId: SYNTHETIC_CO_ID,
          active: true,
          status: 'active',
        },
        resetMode: 'admin',
      };
      const result = validateResetAuthzSnapshot(snap);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_reset_mode');
    });

    test('permanent reset is rejected when policy requires temporary reset', () => {
      const snap = {
        snapshotId: 'snap_syn_1001',
        opId: SYNTHETIC_OP_ID,
        evaluatedAt: '2026-09-18T05:00:00.000Z',
        staffPrincipal: {
          staffUid: SYNTHETIC_ACTOR_UID,
          authTime: '2026-09-18T04:55:00.000Z',
          emailVerified: true,
          isAnonymous: false,
          disabled: false,
        },
        tenantMembership: {
          membershipId: 'mem_syn_001',
          companyId: SYNTHETIC_CO_ID,
          staffUid: SYNTHETIC_ACTOR_UID,
          status: 'active',
          joinedAt: '2026-01-01T00:00:00.000Z',
        },
        tenantRoleCapabilities: {
          companyId: SYNTHETIC_CO_ID,
          staffUid: SYNTHETIC_ACTOR_UID,
          roles: ['security_admin'],
          capabilities: ['canResetDriverPasscode', 'canIssuePermanentPasscode'],
          canResetDriverPasscode: true,
          canIssuePermanentPasscode: true,
        },
        tenantSecurityPolicy: {
          companyId: SYNTHETIC_CO_ID,
          allowAdminPasscodeReset: true,
          allowPermanentPasscodeReset: false,
          requiredPasscodeMinLength: 6,
          maxPasscodeLength: 128,
          requireTemporaryOnReset: true,
        },
        targetDriverBinding: {
          driverId: SYNTHETIC_DRIVER_ID,
          companyId: SYNTHETIC_CO_ID,
          active: true,
          status: 'active',
        },
        resetMode: 'permanent',
      };
      const result = validateResetAuthzSnapshot(snap);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('policy_violation');
    });

    test('changed passcode retry conflicts even when other fields match', () => {
      const req = createValidSyntheticRequest();
      const secretReq = createValidatedSecretBearingRequest(req, SYNTHETIC_COMMITMENT_HASH);
      const commitment = createSanitizedOperationCommitment(secretReq, SYNTHETIC_ACTOR_UID, '2026-09-18T05:00:00.000Z');
      const changed = { ...req, newPasscode: '654321' };
      const otherHash = `hmac-sha256:${'cd'.repeat(32)}`;
      const result = validateOperationRetryCommitment(commitment, changed, otherHash);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('idempotent_retry_conflict');
    });

    test('incomplete existing commitment is rejected before comparison', () => {
      const req = createValidSyntheticRequest();
      const result = validateOperationRetryCommitment({ opId: SYNTHETIC_OP_ID }, req);
      expect(result.ok).toBe(false);
    });

    test('invalid public commitment hash is rejected', () => {
      const err = validateCommitmentHash('not-a-hash');
      expect(err).not.toBeNull();
      expect(err?.code).toBe('invalid_commitment_hash');
      expect(validateCommitmentHash(SYNTHETIC_COMMITMENT_HASH)).toBeNull();
    });

    test('current-writer credential fields pendingId/setBy/opId/temporaryAssigned/passcodeChangedAt are accepted', () => {
      const currentDoc = {
        displayName: 'Test Driver',
        displayNameNorm: 'test driver',
        active: true,
        mustResetPasscode: true,
        pendingId: 'pending_syn_01',
        setBy: SYNTHETIC_ACTOR_UID,
        temporaryAssigned: true,
        opId: SYNTHETIC_OP_ID,
        passcodeChangedAt: '2026-09-18T05:00:00.000Z',
        passcode: {
          algo: 'scrypt',
          N: 16384,
          r: 8,
          p: 1,
          keyLen: 32,
          saltB64: SYNTHETIC_SALT_B64,
          hashB64: SYNTHETIC_HASH_B64,
        },
      };
      const original = { ...currentDoc };
      const result = validateCurrentDriverCredentialDoc(currentDoc);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.pendingId).toBe('pending_syn_01');
        expect(result.value.setBy).toBe(SYNTHETIC_ACTOR_UID);
        currentDoc.displayName = 'mutated';
        expect(result.value.displayName).toBe(original.displayName);
      }
    });

    test('oversized base64 is rejected before decode', () => {
      const cred = {
        ...createValidSyntheticCredential(),
        saltB64: `${'A'.repeat(300)}==`,
      };
      const result = validateCanonicalCredential(cred);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('oversized_base64');
    });

    test('excessive nested depth is rejected', () => {
      let nested: unknown = 'leaf';
      for (let i = 0; i < 10; i += 1) {
        nested = { node: nested };
      }
      const currentDoc = {
        displayName: 'Test Driver',
        passcode: {
          algo: 'scrypt',
          N: 16384,
          r: 8,
          p: 1,
          keyLen: 32,
          saltB64: SYNTHETIC_SALT_B64,
          hashB64: SYNTHETIC_HASH_B64,
        },
        createdAt: nested,
      };
      const result = validateCurrentDriverCredentialDoc(currentDoc);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('excessive_depth');
    });

    test('February 31 is rejected as an invalid calendar date', () => {
      const receipt = {
        ...createValidSyntheticReceipt(),
        appliedAt: '2026-02-31T00:00:00.000Z',
      };
      const result = validateResetReceipt(receipt);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_calendar_date');
    });

    test('maximum incrementable version is rejected on the request', () => {
      const req = { ...createValidSyntheticRequest(), expectedCredentialVersion: 1_000_000 };
      const result = validateCanonicalResetRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('counter_overflow');
    });

    test('retry beyond maximum is rejected and fence must advance on a new attempt', () => {
      const current: AuthCleanupEffect = {
        ...createValidSyntheticEffect(),
        status: 'failed',
        attempts: 5,
        fenceGeneration: 5,
        failedAt: '2026-09-18T05:04:00.000Z',
        terminalError: 'max_retries_exceeded',
      };
      const next: AuthCleanupEffect = {
        ...current,
        status: 'in_progress',
        attempts: 6,
        fenceGeneration: 6,
        lastAttemptAt: '2026-09-18T05:05:00.000Z',
        failedAt: null,
        terminalError: null,
      };
      const result = validateEffectLifecycleTransition(current, next);
      expect(result.ok).toBe(false);
    });

    test('secret-shaped unknown fields cannot enter a cleanup record', () => {
      const effect = {
        ...createValidSyntheticEffect(),
        newPasscode: '123456',
      };
      const result = validateAuthCleanupEffect(effect);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('unknown_field');
    });

    test('proxy trap messages are never echoed', () => {
      const proxyReq = new Proxy(createValidSyntheticRequest(), {
        getPrototypeOf() {
          throw new Error('ATTACKER_SECRET_sk-ant-EXFIL');
        },
      });
      const result = validateCanonicalResetRequest(proxyReq);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(JSON.stringify(result.error)).not.toMatch(/ATTACKER_SECRET|sk-ant-/);
        expect(result.error.code).toBe('property_access_error');
      }
    });
  });
});
