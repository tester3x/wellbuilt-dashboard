/**
 * RUNTIME tests for the Phase-3 company-settings controls (Operations / Photos /
 * DOE Region). Executes the firebase-free core through a MOCK writer and asserts
 * the exact field payload each control sends, the write path, and the photo-int
 * validation. No Firebase, no network, no production writes.
 *
 * The capability GATE (manageCompany / editBilling) is enforced in the
 * components and verified structurally in controlContracts.test.ts — it is not a
 * runtime WORKING claim here (auth.ts pulls the Firebase SDK and cannot be
 * imported into this harness, and rendering the cards needs a DOM runner that is
 * not installed).
 *
 * Run: node --test --experimental-strip-types src/lib/__tests__/companySettingsControls.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runCompanyFieldWrite,
  buildBooleanToggle,
  buildCancelledNumberHandling,
  buildInvoicingMode,
  buildLiveDispatchSync,
  buildRequirePhotos,
  buildMinPhotoCount,
  buildPhotoRetentionDays,
  parsePositivePhotoInt,
  buildDoeRegion,
} from '../companySettingsCore.ts';

function mockWriter() {
  const calls: Array<{ companyId: string; fields: Record<string, unknown> }> = [];
  return {
    calls,
    write: async (companyId: string, fields: Record<string, unknown>) => { calls.push({ companyId, fields }); },
  };
}

// ── Operations control payloads ──────────────────────────────────────────────

test('Operations: boolean toggles flip the current value', () => {
  assert.deepEqual(buildBooleanToggle('splitTickets', false), { splitTickets: true });
  assert.deepEqual(buildBooleanToggle('transferRequiresApproval', true), { transferRequiresApproval: false });
});

test('Operations: segmented pickers send the exact field/value', () => {
  assert.deepEqual(buildCancelledNumberHandling('void'), { cancelledNumberHandling: 'void' });
  assert.deepEqual(buildInvoicingMode('hybrid'), { invoicingMode: 'hybrid' });
  assert.deepEqual(buildInvoicingMode('ticket_only'), { invoicingMode: 'ticket_only' });
});

test('Operations: live dispatch sync carries the caller-supplied value (incl. delete sentinel)', () => {
  assert.deepEqual(buildLiveDispatchSync(true), { liveDispatchSync: true });
  assert.deepEqual(buildLiveDispatchSync(false), { liveDispatchSync: false });
  const sentinel = { __delete: true };
  assert.equal((buildLiveDispatchSync(sentinel) as { liveDispatchSync: unknown }).liveDispatchSync, sentinel);
});

// ── Photos control payloads + validation ─────────────────────────────────────

test('Photos: require toggle flips; count/retention build exact fields', () => {
  assert.deepEqual(buildRequirePhotos(false), { requirePhotos: true });
  assert.deepEqual(buildMinPhotoCount(3), { minPhotoCount: 3 });
  assert.deepEqual(buildPhotoRetentionDays(45), { photoRetentionDays: 45 });
});

test('Photos: parsePositivePhotoInt rejects invalid/<1 (no write), accepts positives', () => {
  assert.equal(parsePositivePhotoInt('0'), null);
  assert.equal(parsePositivePhotoInt('-2'), null);
  assert.equal(parsePositivePhotoInt('abc'), null);
  assert.equal(parsePositivePhotoInt(''), null);
  assert.equal(parsePositivePhotoInt('3'), 3);
  assert.equal(parsePositivePhotoInt('10'), 10);
});

// ── Billing DOE region payload ───────────────────────────────────────────────

test('Billing: DOE region builds {doeRegion}', () => {
  assert.deepEqual(buildDoeRegion('PADD2'), { doeRegion: 'PADD2' });
});

// ── Write path (handler → updateCompanyFields adapter) via mock writer ────────

test('write path: runCompanyFieldWrite calls the writer once with (companyId, fields)', async () => {
  const m = mockWriter();
  await runCompanyFieldWrite(m.write, 'liquid-gold', buildInvoicingMode('hybrid'));
  assert.equal(m.calls.length, 1);
  assert.deepEqual(m.calls[0], { companyId: 'liquid-gold', fields: { invoicingMode: 'hybrid' } });
});

test('write path: a rejected writer propagates (handler surfaces the failure)', async () => {
  const boom = async () => { throw new Error('permission-denied'); };
  await assert.rejects(() => runCompanyFieldWrite(boom, 'c1', buildDoeRegion('PADD3')), /permission-denied/);
});
