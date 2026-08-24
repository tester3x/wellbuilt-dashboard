/**
 * Dashboard Safety / Spill Incidents source tests.
 * Run: node --experimental-strip-types tools/test-spillSafety.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideSafetyAccess, SAFETY_CATEGORIES, safetyCollectionPath, safetyIncidentPath } from '../src/lib/spill/spillAccess.ts';
import {
  classifyFirestoreSpillError,
  classifySpillWorkflowStatus,
  emptyListCopy,
  filterSpillRows,
  isPublicStorageUrl,
  notifyRollupLabel,
  projectSpillDetail,
  projectSpillListRow,
  rollupNotificationStatus,
} from '../src/lib/spill/spillIncidentProjection.ts';
import {
  dedupeRecipientKeys,
  parseSpillPolicy,
  validateSpillPolicy,
  bumpPolicyVersion,
} from '../src/lib/spill/spillNotifyPolicy.ts';
import {
  REQUIRED_SPILL_ACTION_CONTRACTS,
  SPILL_ACTION_CALLABLES,
  SPILL_ACTION_CALLABLES_AVAILABLE,
  buildSpillActionAudit,
  buildSpillActionCallablePayload,
  isSpillActionAvailable,
  spillActionDisabledReason,
  validateSpillAction,
} from '../src/lib/spill/spillActions.ts';
import { TABS } from '../src/lib/tabs.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(join(root, rel), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const platform = { uid: 'p1', email: 'a@x', role: 'admin' };
const tenantAdmin = { uid: 't1', email: 't@x', role: 'admin', companyId: 'acme' };
const otherAdmin = { uid: 't2', email: 'o@x', role: 'admin', companyId: 'other' };
const driver = { uid: 'd1', email: 'd@x', role: 'driver', companyId: 'acme' };
const payroll = { uid: 'y1', email: 'y@x', role: 'payroll', companyId: 'acme' };

// Navigation / permissions
check('Safety tab exists and is not a top-level Spills app', TABS.some((t) => t.id === 'safety' && t.label === 'Safety' && t.href === '/safety' && t.capability === 'viewSafety') && !TABS.some((t) => t.id === 'spills'));
check('future Safety categories exist but only spills is live', SAFETY_CATEGORIES.filter((c) => c.live).map((c) => c.id).join() === 'spills' && SAFETY_CATEGORIES.length >= 6);
check('platform admin may access Safety', decideSafetyAccess(platform, 'acme', { canView: true }).ok === true && decideSafetyAccess(platform, 'acme', { canView: true }).mode === 'platform');
check('tenant admin may access own company', decideSafetyAccess(tenantAdmin, 'acme', { canView: true }).ok === true && decideSafetyAccess(tenantAdmin, 'acme', { canView: true }).companyId === 'acme');
check('cross-company fails closed', decideSafetyAccess(tenantAdmin, 'other', { canView: true }).ok === false && decideSafetyAccess(tenantAdmin, 'other', { canView: true }).reason === 'cross_company');
check('missing company binding fails closed', decideSafetyAccess({ uid: 'x', email: 'x', role: 'manager' }, 'acme', { canView: true }).reason === 'missing_company');
check('no capability fails closed', decideSafetyAccess(tenantAdmin, 'acme', { canView: false }).reason === 'no_capability');
check('driver is denied Dashboard Safety', decideSafetyAccess(driver, 'acme', { canView: true }).reason === 'driver');
const authSrc = src('src/lib/auth.ts');
check('payroll default cannot view Safety', /payroll:\s*\[[\s\S]*?driver: \[\]/.test(authSrc) && !/payroll:\s*\[[^\]]*viewSafety/.test(authSrc));
check('safety role can view and manage', authSrc.includes("safety: [") && authSrc.includes("'viewSafety'") && authSrc.includes("'manageSafety'"));
check('driver capabilities empty', /driver: \[\],/.test(authSrc));

// Tenant path
check('collection path is companies/{id}/spill_incidents', safetyCollectionPath('acme') === 'companies/acme/spill_incidents');
check('incident path nested under company', safetyIncidentPath('acme', 'inc-1') === 'companies/acme/spill_incidents/inc-1');
let threw = false; try { safetyCollectionPath('  '); } catch { threw = true; }
check('empty companyId throws', threw);

// List projection + filters
const accepted = {
  incidentId: 'inc-1',
  companyId: 'acme',
  driverId: 'drv-1',
  status: 'accepted',
  acceptedAt: '2026-08-24T10:00:00.000Z',
  notificationsCreated: false,
  notifyPolicyVersion: 3,
  schemaVersion: 1,
  mediaManifest: {
    photos: [{ photoId: 'p1', slot: 'overview', storagePath: 'spill-photos/acme/inc-1/p1.jpg' }],
    video: { videoId: 'v1', durationSec: 12, uploadState: 'authorized', storagePath: 'spill-videos/acme/inc-1/v1.mp4' },
  },
  report: {
    driverName: 'Pat',
    material: 'produced water',
    estimatedAmount: '8',
    amountUnit: 'BBL',
    notes: 'hose leak',
    gps: { lat: 47.8, lng: -103.2 },
    job: { ticketNumber: '20100', invoiceDocId: 'inv1', lifecyclePhase: 'pickup', wellName: 'GABRIEL 5', operator: 'SLAWSON EXPLORATION COMPANY, INC.' },
  },
};
const row = projectSpillListRow(accepted, { companyName: 'Acme' });
check('accepted maps to open', row && row.status === 'open' && classifySpillWorkflowStatus('accepted') === 'open');
check('list shows driver/company/ticket/phase/location/media', !!(row && row.driverName === 'Pat' && row.companyName === 'Acme' && row.ticketNumber === '20100' && row.phase === 'pickup' && row.location === 'GABRIEL 5' && row.photoCount === 1 && row.videoCount === 1));
check('notification not claimed sent without records', row.notifyRollup === 'notification_service_not_configured');
check('filters open vs all', filterSpillRows([row], 'open').length === 1 && filterSpillRows([{ ...row, status: 'closed' }], 'open').length === 0);
check('empty copy is not an error', emptyListCopy() === 'No spill incidents');

const mal = projectSpillListRow({ status: 'accepted' });
check('malformed incident flagged', mal && mal.malformed === true);

// Load states
check('permission-denied classified', classifyFirestoreSpillError({ code: 'permission-denied' }).kind === 'denied');
check('missing index classified', classifyFirestoreSpillError({ code: 'failed-precondition', message: 'requires an index' }).kind === 'missing_index');
check('retryable classified', classifyFirestoreSpillError({ code: 'unavailable' }).kind === 'retryable');

// Detail + media
const detail = projectSpillDetail(accepted, {
  deliveries: [],
  workerDeployed: false,
  providerConfigured: false,
  mediaInfraReady: false,
});
check('detail schema version and notes', detail && detail.schemaVersion === 1 && detail.notes === 'hose leak' && detail.material === 'produced water');
check('GPS projected', !!(detail && detail.gps && detail.gps.lat === 47.8));
check('media pending when infra down', detail.photos[0].mediaState === 'pending' && detail.video.mediaState === 'pending');
check('public storage URLs rejected', isPublicStorageUrl('https://firebasestorage.googleapis.com/v0/b/x/o/y?alt=media&token=abc') === true);
const leaked = projectSpillDetail({
  ...accepted,
  mediaManifest: { photos: [{ photoId: 'p2', downloadUrl: 'https://firebasestorage.googleapis.com/v0/b/x/o/y?token=abc', url: 'https://storage.googleapis.com/bucket/x' }] },
});
check('projection drops public URLs', leaked.photos[0] && !JSON.stringify(leaked.photos[0]).includes('token=') && !JSON.stringify(leaked.photos[0]).includes('storage.googleapis.com'));

// Delivery honesty
check('rollup stays not-configured without worker', rollupNotificationStatus({ notificationsCreated: true, deliveries: [{ status: 'sent' }], workerDeployed: false, providerConfigured: true }) === 'notification_service_not_configured');
check('delivered only with authoritative statuses', rollupNotificationStatus({
  notificationsCreated: true,
  deliveries: [{ status: 'delivered' }, { status: 'opened' }],
  workerDeployed: true,
  providerConfigured: true,
}) === 'delivered');
check('label is honest', notifyRollupLabel('notification_service_not_configured').includes('not configured'));

// Policy
const policy = parseSpillPolicy({
  enabled: true,
  version: 1,
  recipients: [
    { kind: 'role', role: 'dispatch', channels: 'sms' },
    { kind: 'role', role: 'dispatch', channels: 'sms' },
    { kind: 'role', role: 'safety', channels: 'email' },
    { kind: 'external', externalId: 'e1', email: 'ops@example.com', channels: 'email' },
  ],
});
check('duplicate role+channel collapses', dedupeRecipientKeys(policy).filter((d) => d.key === 'role:dispatch').length === 1);
check('valid policy', validateSpillPolicy(policy).ok === true);
check('external access requires expiration', validateSpillPolicy({ ...policy, externalAccessEnabled: true }).ok === false);
check('bump version', bumpPolicyVersion(policy, '2026-08-24T00:00:00.000Z', 'u1').version === 2);

const badExt = parseSpillPolicy({ enabled: true, version: 0, recipients: [{ kind: 'external', externalId: 'x', channels: 'sms' }] });
check('external SMS without phone fails', validateSpillPolicy(badExt).ok === false);

// Actions disabled
check('no action callable marked available', Object.values(SPILL_ACTION_CALLABLES_AVAILABLE).every((v) => v === false));
check('acknowledge disabled with callable name', spillActionDisabledReason('acknowledge').includes(SPILL_ACTION_CALLABLES.acknowledge) && isSpillActionAvailable('acknowledge') === false);
const act = { type: 'acknowledge', companyId: 'acme', incidentId: 'inc-1', reason: 'seen' };
check('validate ack from open', validateSpillAction(act, 'accepted').ok === true);
check('reopen requires reason', validateSpillAction({ type: 'reopen', companyId: 'acme', incidentId: 'inc-1', reason: '' }, 'closed').ok === false);
const audit = buildSpillActionAudit(act, { uid: 't1', name: 'Pat' }, 'open', '2026-08-24T11:00:00.000Z');
check('audit retains actor/time/reason/prior/result', audit.actorUid === 't1' && audit.priorStatus === 'open' && audit.resultingStatus === 'acknowledged' && audit.reason === 'seen');
check('callable payload is typed not a direct write', buildSpillActionCallablePayload(act, audit).action === 'acknowledge' && REQUIRED_SPILL_ACTION_CONTRACTS.length === 6);

// Source pins
const listUi = src('src/components/safety/SpillIncidentList.tsx');
const detailUi = src('src/components/safety/SpillIncidentDetail.tsx');
const page = src('src/app/safety/page.tsx');
const store = src('src/lib/spill/spillIncidentStore.ts');
const card = src('src/components/settings/SpillNotificationCard.tsx');
check('list has required filters', ['Open', 'Acknowledged', 'Resolved', 'Closed', 'All'].every((f) => listUi.includes(f)));
check('list empty copy used', listUi.includes('emptyListCopy'));
check('detail never shows downloadUrl', !detailUi.includes('downloadUrl') && detailUi.includes('Governed storage paths'));
check('actions stay disabled without callables', detailUi.includes('isSpillActionAvailable') && detailUi.includes('not deployed'));
check('Safety page uses company-scoped store', page.includes('listSpillIncidents') && store.includes("companies/${cid}/spill_incidents") === false);
check('store uses safetyCollectionPath', store.includes('safetyCollectionPath'));
check('settings card has no Liquid Gold recipients', !/liquid.?gold|mikezfold|slawson/i.test(card));
check('notify policy roles include dispatch safety lead', src('src/lib/spill/spillNotifyPolicy.ts').includes("'dispatch'") && src('src/lib/spill/spillNotifyPolicy.ts').includes("'safety'") && src('src/lib/spill/spillNotifyPolicy.ts').includes("'lead'"));
check('employee editor lists safety and lead', src('src/components/admin/EmployeePanel.tsx').includes("role: 'safety'") && src('src/components/admin/EmployeePanel.tsx').includes("role: 'lead'"));
check('DriversTab role pickers include safety and lead', src('src/components/admin/DriversTab.tsx').includes("'safety'") && src('src/components/admin/DriversTab.tsx').includes("'lead'"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
