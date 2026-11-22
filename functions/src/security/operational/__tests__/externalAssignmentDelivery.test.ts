import { readFileSync } from 'fs';
import { join } from 'path';
import type {
  ExternalDeliveryProvider,
  ExternalDeliveryProviderResult,
  ExternalDeliveryRequest,
} from '../../externalDeliveryProvider';
import { UnconfiguredExternalDeliveryProvider } from '../../externalDeliveryProvider';
import {
  EXTERNAL_DELIVERY_STATUSES,
  applyExternalProviderResult,
  deliveryIdForKey,
  parseExternalDriverWrite,
  planExternalAssignmentCancellation,
  planExternalAssignmentRevision,
  planExternalResponse,
  type ExternalDeliveryRoot,
  type ExternalDriverRecord,
} from '../externalAssignmentDelivery';

const driver: ExternalDriverRecord = {
  externalDriverId: 'outside-joe',
  companyId: 'acme',
  displayName: 'Joe Outside',
  phoneE164: '+17015550123',
  channels: ['sms', 'whatsapp'],
  active: true,
};

function assigned(existing: ExternalDeliveryRoot | null = null, action: 'assigned' | 'retried' | 'reassigned' = 'assigned') {
  return planExternalAssignmentRevision({
    companyId: 'acme',
    actorUid: 'dispatcher-1',
    nowIso: '2026-11-20T12:00:00.000Z',
    idempotencyKey: `key-${action}`,
    dispatchId: 'dispatch-1',
    externalDriver: driver,
    channel: 'sms',
    action,
    existing,
  });
}

describe('external driver roster containment', () => {
  it('accepts a strict company-scoped contact without provider-specific fields', () => {
    expect(parseExternalDriverWrite({
      externalDriverId: 'outside-joe',
      displayName: 'Joe Outside',
      phoneE164: '+17015550123',
      channels: ['sms', 'whatsapp'],
      active: true,
    }, 'acme')).toMatchObject({ ok: true, externalDriverId: 'outside-joe', shiftPreference: 'unset' });
    expect(parseExternalDriverWrite({
      externalDriverId: 'outside-joe', displayName: 'Joe Outside', phoneE164: '', channels: [], active: true,
      shiftPreference: 'night',
    }, 'acme')).toMatchObject({ ok: true, shiftPreference: 'night' });
  });

  it('allows name-only roster entries but never sends to them', () => {
    const { companyId: _companyId, ...withoutCompany } = driver;
    const nameOnly = { ...withoutCompany, phoneE164: '', channels: [] as ExternalDriverRecord['channels'] };
    expect(parseExternalDriverWrite(nameOnly, 'acme')).toMatchObject({ ok: true, phoneE164: '', channels: [] });
    expect(planExternalAssignmentRevision({ companyId: 'acme', actorUid: 'dispatcher-1', nowIso: '2026-11-20T12:00:00.000Z',
      idempotencyKey: 'name-only', dispatchId: 'dispatch-1', externalDriver: { ...nameOnly, companyId: 'acme' }, channel: 'sms', action: 'assigned', existing: null }))
      .toMatchObject({ ok: false, reason: 'invalid_phone' });
    expect(parseExternalDriverWrite({ ...nameOnly, channels: ['sms'] }, 'acme')).toMatchObject({ ok: false, reason: 'invalid_channels' });
    const contactOnly = { ...nameOnly, phoneE164: '+17015550124' };
    expect(parseExternalDriverWrite(contactOnly, 'acme')).toMatchObject({ ok: true, phoneE164: '+17015550124', channels: [] });
    expect(planExternalAssignmentRevision({ companyId: 'acme', actorUid: 'dispatcher-1', nowIso: '2026-11-20T12:00:00.000Z',
      idempotencyKey: 'contact-only', dispatchId: 'dispatch-1', externalDriver: { ...contactOnly, companyId: 'acme' }, channel: 'sms', action: 'assigned', existing: null }))
      .toMatchObject({ ok: false, reason: 'channel_not_enabled' });
  });

  it('rejects malformed phone numbers, unknown fields, and cross-company assignment', () => {
    expect(parseExternalDriverWrite({
      externalDriverId: 'joe', displayName: 'Joe', phoneE164: '701-555-0123', channels: ['sms'], active: true,
    }, 'acme')).toMatchObject({ ok: false, reason: 'invalid_phone' });
    expect(parseExternalDriverWrite({
      externalDriverId: 'joe', displayName: 'Joe', phoneE164: '+17015550123', channels: ['sms'], active: true, providerToken: 'no',
    }, 'acme')).toMatchObject({ ok: false, reason: 'unexpected_field', field: 'providerToken' });
    expect(parseExternalDriverWrite({
      externalDriverId: 'joe', displayName: 'Joe', phoneE164: '', channels: [], active: true, shiftPreference: 'graveyard',
    }, 'acme')).toMatchObject({ ok: false, reason: 'invalid_shift_preference' });
    expect(planExternalAssignmentRevision({
      companyId: 'other', actorUid: 'u', nowIso: '2026-11-20T12:00:00.000Z', idempotencyKey: 'k',
      dispatchId: 'dispatch-1', externalDriver: driver, channel: 'sms', action: 'assigned', existing: null,
    })).toMatchObject({ ok: false, reason: 'cross_company' });
  });
});

describe('durable delivery revisions', () => {
  it('publishes every truthful delivery status and begins at queued', () => {
    expect(EXTERNAL_DELIVERY_STATUSES).toEqual(['queued', 'sent', 'delivered', 'accepted', 'declined', 'failed']);
    const plan = assigned();
    expect(plan).toMatchObject({
      ok: true,
      root: { currentRevision: 1, currentStatus: 'queued', assignmentState: 'active' },
      revision: { revision: 1, status: 'queued', action: 'assigned', history: [{ status: 'queued' }] },
    });
  });

  it('uses deterministic ids for create retry safety', () => {
    expect(deliveryIdForKey('acme', 'same-key')).toBe(deliveryIdForKey('acme', 'same-key'));
    expect(deliveryIdForKey('acme', 'same-key')).not.toBe(deliveryIdForKey('other', 'same-key'));
  });

  it('reports unconfigured as failed/not-sent rather than sent', async () => {
    const plan = assigned();
    if (!plan.ok) throw new Error(plan.reason);
    const provider = new UnconfiguredExternalDeliveryProvider();
    const result = await provider.send({
      deliveryId: plan.revision.deliveryId,
      revision: 1,
      channel: 'sms',
      phoneE164: driver.phoneE164,
      dispatchId: 'dispatch-1',
    });
    expect(result).toEqual({ kind: 'unconfigured' });
    const finalized = applyExternalProviderResult(plan.revision, { kind: 'unconfigured', at: '2026-11-20T12:00:01.000Z' });
    expect(finalized).toMatchObject({
      status: 'failed',
      failureCode: 'provider_unconfigured',
      history: [{ status: 'queued' }, { status: 'failed', reason: 'provider_unconfigured', notSent: true }],
    });
  });

  it('allows retry only after failure and carries a superseding revision', () => {
    const first = assigned();
    if (!first.ok) throw new Error(first.reason);
    expect(assigned(first.root, 'retried')).toMatchObject({ ok: false, reason: 'retry_not_allowed' });
    const failedRoot = { ...first.root, currentStatus: 'failed' as const };
    expect(assigned(failedRoot, 'retried')).toMatchObject({
      ok: true,
      root: { currentRevision: 2, currentStatus: 'queued' },
      revision: { revision: 2, supersedesRevision: 1, action: 'retried' },
    });
  });

  it('records cancellation separately from delivery truth and blocks retry', () => {
    const first = assigned();
    if (!first.ok) throw new Error(first.reason);
    const failedRoot = { ...first.root, currentStatus: 'failed' as const };
    const cancelled = planExternalAssignmentCancellation({
      existing: failedRoot,
      companyId: 'acme',
      actorUid: 'dispatcher-1',
      nowIso: '2026-11-20T12:05:00.000Z',
      idempotencyKey: 'cancel-1',
    });
    expect(cancelled).toMatchObject({
      ok: true,
      root: { currentRevision: 2, currentStatus: 'failed', assignmentState: 'cancelled' },
      revision: { action: 'cancelled', status: 'failed', assignmentState: 'cancelled' },
    });
    if (!cancelled.ok) throw new Error(cancelled.reason);
    expect(assigned(cancelled.root, 'retried')).toMatchObject({ ok: false, reason: 'assignment_cancelled' });
  });

  it('models delivered/accepted/declined transitions without exposing an unauthenticated response endpoint', () => {
    expect(planExternalResponse('sent', 'delivered')).toEqual({ ok: true, status: 'delivered' });
    expect(planExternalResponse('delivered', 'accepted')).toEqual({ ok: true, status: 'accepted' });
    expect(planExternalResponse('delivered', 'declined')).toEqual({ ok: true, status: 'declined' });
    expect(planExternalResponse('queued', 'accepted')).toMatchObject({ ok: false, reason: 'invalid_delivery_transition' });
  });
});

describe('provider boundary', () => {
  class MockProvider implements ExternalDeliveryProvider {
    readonly name = 'local-test-mock';
    readonly calls: ExternalDeliveryRequest[] = [];
    async send(request: ExternalDeliveryRequest): Promise<ExternalDeliveryProviderResult> {
      this.calls.push(request);
      return { kind: 'sent', providerMessageId: 'mock-only-1' };
    }
  }

  it('uses a mock only inside this local test', async () => {
    const provider = new MockProvider();
    const result = await provider.send({
      deliveryId: 'ext_1', revision: 1, channel: 'whatsapp', phoneE164: '+17015550123', dispatchId: 'dispatch-1',
    });
    expect(result).toEqual({ kind: 'sent', providerMessageId: 'mock-only-1' });
    expect(provider.calls).toHaveLength(1);
  });

  it('keeps the callable company-bound, independent of chat, and provider-unconfigured by default', () => {
    const callable = readFileSync(join(__dirname, '../../externalAssignmentDeliveryCallable.ts'), 'utf8');
    expect(callable).toMatch(/requireTrustedCompanyCapability/);
    expect(callable).toMatch(/TRUSTED_CAPABILITY_MANAGE_DRIVERS/);
    expect(callable).toMatch(/externalDriverAccessMode\(companySnap\.data\(\), accessSnap\.data\(\)\)/);
    expect(callable).toMatch(/external_driver_access_inactive/);
    expect(callable).toMatch(/dispatch\.companyId !== authority\.companyId/);
    expect(callable).toMatch(/externalDeliveryProvider\(\)/);
    expect(callable).not.toMatch(/staffChat|shiftDispatchChat|dispatchConversations/);
  });
});
