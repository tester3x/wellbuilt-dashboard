import {
  assertExactPendingKey,
  assertExactUid,
  assertConfirm,
  collectAuthUidsFromRecords,
  evaluateRejectPendingRegistration,
  evaluateCleanupTestIdentity,
  provenSecurePendingLink,
  provenPendingCredentialsLink,
  summarizeActionResults,
  IdentityCleanupError,
  OPERATIONAL_IDENTITY_SURFACES,
} from '../identityCleanup';

const FOUR = [
  { key: '-Ozxe1ukGLJOqirCeGaF', displayName: 'ncpoig', securePendingId: 'ad0243c9-e5c5-4556-9d6e-cda6bdea1d4a' },
  { key: '-P-6LeYQBCdwM-R9RGEc', displayName: 'dgurwq' },
  { key: '-P-6NWKoZYVHJ6GM-cUA', displayName: 'vwksss' },
  { key: '-P-6b64Jr-6ipRMleWRI', displayName: 'kxquaj' },
];

const SEVEN = [
  'H0kiAgFbjKQtJhQzaaPtwqEyr0F2',
  'V55mu39biWSs3b9ele4WwgElIYF2',
  'fK95W5NQFmMxiCqPMVjhgtNTM013',
  'hBhz0ld47XZNo7ley6QbkUmssRR2',
  'hRY8VOuT2VXCNZYcKO7DGyFU9Zb2',
  'nteVBknsX1R90BRa6cjiIcXmCBF2',
  'rgA6htGH7IUdnfB2zEApxCcY5ve2',
];

const baseReject = {
  pendingKey: FOUR[0].key,
  pending: { displayName: 'ncpoig', status: 'pending', source: 'wbs', securePendingId: FOUR[0].securePendingId },
  pendingSecure: { displayName: 'ncpoig', status: 'pending' },
  pendingCredentials: { displayNameNorm: 'ncpoig' },
  approvedMatchCount: 0,
  nameIndexExists: false,
  linkedAuthUids: [] as string[],
  operationalHits: [] as string[],
  scanOk: true,
  authLookupOk: true,
};

describe('pending-key and UID guards', () => {
  it('accepts the four exact live pending keys and rejects wildcards', () => {
    for (const row of FOUR) expect(assertExactPendingKey(row.key)).toBe(row.key);
    for (const bad of ['*', '-P-6*', 'drivers/pending/-Ozxe1ukGLJOqirCeGaF', '-Ozxe1ukGLJOqirCeGaF,-P-6LeYQBCdwM-R9RGEc', '', ' ncpoig ']) {
      expect(() => assertExactPendingKey(bad)).toThrow(IdentityCleanupError);
    }
  });

  it('accepts the seven exact UIDs and rejects domain-wide input', () => {
    for (const uid of SEVEN) expect(assertExactUid(uid)).toBe(uid);
    for (const bad of ['*', '@test.local', 'sec-op-admin-', 'H0kiAgFbjKQtJhQzaaPtwqEyr0F2,V55mu39biWSs3b9ele4WwgElIYF2', '']) {
      expect(() => assertExactUid(bad)).toThrow(IdentityCleanupError);
    }
  });

  it('requires an exact confirm key', () => {
    expect(() => assertConfirm({ confirmKey: '', expected: FOUR[0].key })).toThrow(/confirm_required/);
    expect(() => assertConfirm({ confirmKey: 'nope', expected: FOUR[0].key })).toThrow(/confirm_mismatch/);
    expect(() => assertConfirm({ confirmKey: FOUR[0].key, expected: FOUR[0].key })).not.toThrow();
  });
});

describe('proven linkage', () => {
  it('does not trust UUID shape alone', () => {
    expect(provenSecurePendingLink({
      pending: baseReject.pending,
      pendingSecure: null,
      securePendingId: FOUR[0].securePendingId!,
    })).toBe(false);
    expect(provenSecurePendingLink({
      pending: baseReject.pending,
      pendingSecure: { displayName: 'someone-else', status: 'pending' },
      securePendingId: FOUR[0].securePendingId!,
    })).toBe(false);
    expect(provenSecurePendingLink({
      pending: baseReject.pending,
      pendingSecure: baseReject.pendingSecure,
      securePendingId: FOUR[0].securePendingId!,
    })).toBe(true);
  });

  it('requires credentials displayNameNorm to match', () => {
    expect(provenPendingCredentialsLink({
      pending: baseReject.pending,
      credentials: { displayNameNorm: 'other' },
      securePendingId: FOUR[0].securePendingId!,
    })).toBe(false);
    expect(provenPendingCredentialsLink({
      pending: baseReject.pending,
      credentials: { displayNameNorm: 'ncpoig' },
      securePendingId: FOUR[0].securePendingId!,
    })).toBe(true);
  });

  it('discovers Auth UIDs from records instead of assuming none', () => {
    expect(collectAuthUidsFromRecords([
      { displayName: 'ncpoig' },
      { authUid: SEVEN[0] },
    ])).toEqual([SEVEN[0]]);
    expect(collectAuthUidsFromRecords([{}, {}], [SEVEN[0], SEVEN[1]]).sort()).toEqual([SEVEN[0], SEVEN[1]].sort());
  });
});

describe('evaluateRejectPendingRegistration', () => {
  it('fails closed when the operational scan or auth lookup fails', () => {
    expect(evaluateRejectPendingRegistration({ ...baseReject, scanOk: false })).toEqual({ ok: false, reason: 'operational_scan_failed' });
    expect(evaluateRejectPendingRegistration({ ...baseReject, authLookupOk: false })).toEqual({ ok: false, reason: 'auth_lookup_failed' });
  });

  it('is idempotent when the pending row is already gone', () => {
    const out = evaluateRejectPendingRegistration({ ...baseReject, pending: null, pendingSecure: null, pendingCredentials: null });
    expect(out).toEqual({ ok: true, idempotent: true, reason: 'already_absent', actions: [] });
  });

  it('refuses approved, ambiguous, unproven, and operational identities', () => {
    expect(evaluateRejectPendingRegistration({ ...baseReject, pending: { ...baseReject.pending, status: 'approved' } }).ok).toBe(false);
    expect(evaluateRejectPendingRegistration({ ...baseReject, approvedMatchCount: 1 })).toEqual({ ok: false, reason: 'ambiguous_approved_identity' });
    expect(evaluateRejectPendingRegistration({ ...baseReject, nameIndexExists: true })).toEqual({ ok: false, reason: 'ambiguous_name_index' });
    expect(evaluateRejectPendingRegistration({ ...baseReject, linkedAuthUids: ['a'.repeat(28), 'b'.repeat(28)] })).toEqual({ ok: false, reason: 'ambiguous_auth_linkage' });
    expect(evaluateRejectPendingRegistration({ ...baseReject, operationalHits: ['tickets'] })).toEqual({ ok: false, reason: 'operational_records_present' });
    expect(evaluateRejectPendingRegistration({
      ...baseReject,
      pendingSecure: { displayName: 'mismatch' },
    })).toEqual({ ok: false, reason: 'unproven_secure_linkage' });
  });

  it('removes only proven pending + secure + credentials; no Auth when linkage is zero', () => {
    const out = evaluateRejectPendingRegistration(baseReject);
    expect(out.ok).toBe(true);
    if (out.ok && !out.idempotent) {
      expect(out.actions).toEqual([
        { op: 'removePending', path: 'drivers/pending/-Ozxe1ukGLJOqirCeGaF' },
        { op: 'removePendingSecure', path: 'drivers/pending_secure/ad0243c9-e5c5-4556-9d6e-cda6bdea1d4a' },
        { op: 'removePendingCredentials', id: 'ad0243c9-e5c5-4556-9d6e-cda6bdea1d4a' },
      ]);
      expect(out.actions.some((a) => a.op === 'deleteProvisionalAuth')).toBe(false);
    }
  });

  it('does not propose secure/credential deletion when those records are absent', () => {
    const out = evaluateRejectPendingRegistration({
      ...baseReject,
      pending: { displayName: 'dgurwq', source: 'wbjsa' },
      pendingSecure: null,
      pendingCredentials: null,
    });
    expect(out.ok).toBe(true);
    if (out.ok && !out.idempotent) {
      expect(out.actions).toEqual([
        { op: 'removePending', path: 'drivers/pending/-Ozxe1ukGLJOqirCeGaF' },
      ]);
    }
  });

  it('adds Auth delete only when exactly one UID is discovered', () => {
    const out = evaluateRejectPendingRegistration({ ...baseReject, linkedAuthUids: [SEVEN[0]] });
    expect(out.ok).toBe(true);
    if (out.ok && !out.idempotent) {
      expect(out.actions.some((a) => a.op === 'deleteProvisionalAuth' && a.uid === SEVEN[0])).toBe(true);
    }
  });
});

describe('evaluateCleanupTestIdentity', () => {
  it('fails closed on scan/auth lookup failure', () => {
    expect(evaluateCleanupTestIdentity({
      uid: SEVEN[0], user: { email: 'sec-inv-ms9szvlw@test.local', disposable: true },
      authEmail: 'sec-inv-ms9szvlw@test.local', authLookupOk: true, operationalHits: [], scanOk: false,
    })).toEqual({ ok: false, reason: 'operational_scan_failed' });
    expect(evaluateCleanupTestIdentity({
      uid: SEVEN[0], user: { email: 'sec-inv-ms9szvlw@test.local', disposable: true },
      authEmail: null, authLookupOk: false, operationalHits: [], scanOk: true,
    })).toEqual({ ok: false, reason: 'auth_lookup_failed' });
  });

  it('refuses non-test.local and incomplete provenance', () => {
    expect(evaluateCleanupTestIdentity({
      uid: SEVEN[0], user: { email: 'mike@wellbuilt.com', disposable: true },
      authEmail: 'mike@wellbuilt.com', authLookupOk: true, operationalHits: [], scanOk: true,
    })).toEqual({ ok: false, reason: 'not_test_local' });
    expect(evaluateCleanupTestIdentity({
      uid: SEVEN[0], user: { email: 'sec-inv-ms9szvlw@test.local' },
      authEmail: 'sec-inv-ms9szvlw@test.local', authLookupOk: true, operationalHits: [], scanOk: true,
    })).toEqual({ ok: false, reason: 'provenance_incomplete' });
  });

  it('authorizes one-UID removal for disposable test.local profiles', () => {
    const out = evaluateCleanupTestIdentity({
      uid: SEVEN[0],
      user: { email: 'sec-inv-ms9szvlw@test.local', disposable: true, role: 'admin' },
      authEmail: 'sec-inv-ms9szvlw@test.local',
      authLookupOk: true,
      operationalHits: [],
      scanOk: true,
    });
    expect(out).toEqual({
      ok: true,
      idempotent: false,
      email: 'sec-inv-ms9szvlw@test.local',
      actions: [
        { op: 'removeUserProfile', path: `users/${SEVEN[0]}` },
        { op: 'deleteAuth', uid: SEVEN[0] },
      ],
    });
  });
});

describe('partial-failure summary', () => {
  it('never reports ok after a failed delete, and treats already_absent as retry-safe', () => {
    const partial = summarizeActionResults([
      { op: 'removePending', target: 'a', status: 'applied' },
      { op: 'removePendingCredentials', target: 'b', status: 'failed', error: 'PERMISSION_DENIED' },
    ]);
    expect(partial.ok).toBe(false);
    expect(partial.retryable).toBe(true);
    expect(partial.failed).toBe(1);
    const retry = summarizeActionResults([
      { op: 'removePending', target: 'a', status: 'already_absent' },
      { op: 'removePendingCredentials', target: 'b', status: 'applied' },
    ]);
    expect(retry.ok).toBe(true);
    expect(retry.alreadyAbsent).toBe(1);
  });

  it('retains security_audit as a scanned but never-deleted surface', () => {
    expect(OPERATIONAL_IDENTITY_SURFACES.some((s) => s.surface === 'security_audit' && s.retain)).toBe(true);
  });
});
