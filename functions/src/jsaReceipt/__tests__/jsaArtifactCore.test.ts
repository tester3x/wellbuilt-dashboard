import {
  artifactPath,
  decideArtifactWrite,
  parseArtifactInput,
  type GovernedSnapshot,
} from '../jsaArtifactCore';
import type { AuthPrincipal, JsaAuthorityBinding, JsaGovernedRecord } from '../jsaReceiptCore';

const requestId = 'A'.repeat(43);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64');
const binding: JsaAuthorityBinding = {
  shiftState: 'open', periodId: 'shift-1', originLocalDate: '2026-08-22',
  requiresActiveShift: true, jsaEnabled: true,
};
const principal: AuthPrincipal = { uid: 'firebase-uid', app: 'jsa', driverId: 'driver-1', companyId: 'company-1', kind: 'driver' };
const request: JsaGovernedRecord = {
  requestId, jobRef: 'job-1', groupRef: 'group-1', intent: 'read_and_acknowledge',
  driverId: 'driver-1', companyId: 'company-1', binding, state: 'completed',
  action: 'read_and_acknowledged', receiptHandle: 'opaque', createdAtMs: 1,
  expiresAtMs: 10_000, completedAtMs: 2, wbtConsumedAtMs: null,
};
const snapshot: GovernedSnapshot = {
  prepared: { trained: true }, locationAcks: {}, locations: ['Location'],
  stepsAcknowledged: true, stepAcks: { one: true }, ppeSelected: { gloves: true },
  ppeOtherItems: [], notes: 'clear', pusher: '', otherInfo: '', printedName: 'Driver Name',
  signature: { mimeType: 'image/png', data: png }, truckNumber: 'T-1', formDate: '2026-08-22',
};

function decide(overrides: Partial<Parameters<typeof decideArtifactWrite>[0]> = {}) {
  return decideArtifactWrite({
    request, existing: null, requestId, snapshot, signatureBytes: Buffer.from(png, 'base64'),
    principal, binding, nowMs: 3, ...overrides,
  });
}

describe('governed JSA artifact', () => {
  test('accepts only requestId plus frozen snapshot and canonical PNG', () => {
    expect(parseArtifactInput({ requestId, snapshot }).ok).toBe(true);
    expect(parseArtifactInput({ requestId, snapshot, driverId: 'forged' }).ok).toBe(false);
    expect(parseArtifactInput({ requestId, snapshot: { ...snapshot, companyId: 'forged' } }).ok).toBe(false);
    expect(parseArtifactInput({ requestId, snapshot: { ...snapshot, notes: 'x'.repeat(4001) } }).ok).toBe(false);
    expect(parseArtifactInput({ requestId, snapshot: { ...snapshot, signature: { mimeType: 'image/png', data: 'AAAA' } } }).ok).toBe(false);
  });

  test('creates one server-bound artifact with server hashes', () => {
    const out = decide();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(artifactPath(requestId)).toBe(`jsa_governed_artifacts/${requestId}`);
    expect(out.value.write).toBe('create');
    expect(out.value.artifact).toMatchObject({
      requestId, driverId: 'driver-1', companyId: 'company-1', jobRef: 'job-1',
      action: 'read_and_acknowledged', binding, schemaVersion: 1,
    });
    expect(out.value.artifact.actorUidHash).toHaveLength(64);
    expect(out.value.artifact.snapshotHash).toHaveLength(64);
    expect(out.value.artifact.signature).toMatchObject({ mimeType: 'image/png', encoding: 'base64', byteSize: 11 });
    expect(out.value.artifact.signature.sha256).toHaveLength(64);
    expect(out.value.artifact.signature).not.toHaveProperty('data');
  });

  test('identical retry reuses and changed snapshot conflicts', () => {
    const first = decide();
    if (!first.ok) throw new Error('fixture');
    const same = decide({ existing: first.value.artifact });
    expect(same.ok && same.value.write).toBe('reuse');
    const changed = decide({ existing: first.value.artifact, snapshot: { ...snapshot, notes: 'changed' } });
    expect(changed).toMatchObject({ ok: false, refusal: 'conflict' });
  });

  test('requires completed request, same actor, UID, and live binding', () => {
    expect(decide({ request: { ...request, state: 'pending', action: null } })).toMatchObject({ ok: false, refusal: 'pending' });
    expect(decide({ principal: { ...principal, driverId: 'other' } })).toMatchObject({ ok: false, refusal: 'binding_mismatch' });
    expect(decide({ binding: { ...binding, periodId: 'shift-2' } })).toMatchObject({ ok: false, refusal: 'binding_mismatch' });
    const first = decide();
    if (!first.ok) throw new Error('fixture');
    expect(decide({ existing: first.value.artifact, principal: { ...principal, uid: 'other-uid' } }))
      .toMatchObject({ ok: false, refusal: 'binding_mismatch' });
  });
});
