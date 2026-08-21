import {
  assertExactPendingKey,
  assertExactUid,
  assertConfirm,
  evaluateRejectPendingRegistration,
  evaluateCleanupTestIdentity,
  IdentityCleanupError,
} from '../identityCleanup';

const FOUR = [
  { key: '-Ozxe1ukGLJOqirCeGaF', displayName: 'ncpoig' },
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

describe('evaluateRejectPendingRegistration', () => {
  it('is idempotent when the pending row is already gone', () => {
    const out = evaluateRejectPendingRegistration({
      pendingKey: FOUR[0].key,
      pending: null,
      pendingSecure: null,
      approvedMatchCount: 0,
      nameIndexExists: false,
      linkedAuthUids: [],
      operationalHits: [],
    });
    expect(out).toEqual({ ok: true, idempotent: true, reason: 'already_absent', actions: [] });
  });

  it('refuses approved, ambiguous, and operational identities', () => {
    const base = {
      pendingKey: FOUR[0].key,
      pending: { displayName: 'ncpoig', status: 'pending' },
      pendingSecure: null,
      approvedMatchCount: 0,
      nameIndexExists: false,
      linkedAuthUids: [] as string[],
      operationalHits: [] as string[],
    };
    expect(evaluateRejectPendingRegistration({ ...base, pending: { status: 'approved' } }).ok).toBe(false);
    expect(evaluateRejectPendingRegistration({ ...base, approvedMatchCount: 1 })).toEqual({ ok: false, reason: 'ambiguous_approved_identity' });
    expect(evaluateRejectPendingRegistration({ ...base, nameIndexExists: true })).toEqual({ ok: false, reason: 'ambiguous_name_index' });
    expect(evaluateRejectPendingRegistration({ ...base, linkedAuthUids: ['a', 'b'] })).toEqual({ ok: false, reason: 'ambiguous_auth_linkage' });
    expect(evaluateRejectPendingRegistration({ ...base, operationalHits: ['tickets'] })).toEqual({ ok: false, reason: 'operational_records_present' });
  });

  it('removes only the exact pending row and linked secure pending when proven', () => {
    const out = evaluateRejectPendingRegistration({
      pendingKey: FOUR[0].key,
      pending: {
        displayName: 'ncpoig',
        status: 'pending',
        source: 'wbs',
        securePendingId: 'ad0243c9-e5c5-4556-9d6e-cda6bdea1d4a',
      },
      pendingSecure: { status: 'pending' },
      approvedMatchCount: 0,
      nameIndexExists: false,
      linkedAuthUids: [],
      operationalHits: [],
    });
    expect(out.ok).toBe(true);
    if (out.ok && !out.idempotent) {
      expect(out.actions).toEqual([
        { op: 'removePending', path: 'drivers/pending/-Ozxe1ukGLJOqirCeGaF' },
        { op: 'removePendingSecure', path: 'drivers/pending_secure/ad0243c9-e5c5-4556-9d6e-cda6bdea1d4a' },
        { op: 'removePendingCredentials', id: 'ad0243c9-e5c5-4556-9d6e-cda6bdea1d4a' },
      ]);
    }
  });
});

describe('evaluateCleanupTestIdentity', () => {
  it('refuses non-test.local and incomplete provenance', () => {
    expect(evaluateCleanupTestIdentity({
      uid: SEVEN[0],
      user: { email: 'mike@wellbuilt.com', disposable: true },
      authEmail: 'mike@wellbuilt.com',
      operationalHits: [],
    })).toEqual({ ok: false, reason: 'not_test_local' });
    expect(evaluateCleanupTestIdentity({
      uid: SEVEN[0],
      user: { email: 'sec-inv-ms9szvlw@test.local' },
      authEmail: 'sec-inv-ms9szvlw@test.local',
      operationalHits: [],
    })).toEqual({ ok: false, reason: 'provenance_incomplete' });
  });

  it('refuses operational records and email mismatch', () => {
    expect(evaluateCleanupTestIdentity({
      uid: SEVEN[0],
      user: { email: 'sec-inv-ms9szvlw@test.local', disposable: true },
      authEmail: 'sec-inv-ms9szvlw@test.local',
      operationalHits: ['dispatches'],
    })).toEqual({ ok: false, reason: 'operational_records_present' });
    expect(evaluateCleanupTestIdentity({
      uid: SEVEN[0],
      user: { email: 'sec-inv-ms9szvlw@test.local', disposable: true },
      authEmail: 'other@test.local',
      operationalHits: [],
    })).toEqual({ ok: false, reason: 'ambiguous_auth_linkage' });
  });

  it('authorizes one-UID removal for disposable test.local profiles', () => {
    const out = evaluateCleanupTestIdentity({
      uid: SEVEN[0],
      user: { email: 'sec-inv-ms9szvlw@test.local', disposable: true, role: 'admin' },
      authEmail: 'sec-inv-ms9szvlw@test.local',
      operationalHits: [],
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
