/**
 * Dashboard control-contract tests.
 *
 * A rendered button is not "working" merely because a callable is deployed —
 * the chain control→handler→callable→payload→capability→response/error UI must
 * hold. These tests mechanically catch the failure classes called out in the
 * button-recovery packet: missing/wrong callable names, legacy rules-denied
 * direct writes, dead/no-op buttons, and regressions of the governed baseline.
 *
 * Run: node --test --experimental-strip-types src/lib/__tests__/controlContracts.test.ts
 *
 * Pure static analysis over source + a committed snapshot of the deployed
 * callable inventory. No Firebase, no network, no production calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../', import.meta.url)); // .../src/
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const DEPLOYED: { names: string[] } = JSON.parse(read('./deployedCallables.json'));
const deployedSet = new Set(DEPLOYED.names);

/**
 * Callables the Dashboard invokes that are NOT deployed. Each is BLOCKED on a
 * backend/security dependency owned outside the Dashboard lane. When a backend
 * deploys one, this list must shrink (a test below enforces that).
 */
const KNOWN_BLOCKED_MISSING: Record<string, string> = {
  updateSpillNotificationPolicy: 'BLOCKED: deploy the spill-notification-policy callable (no deployed target).',
  staffBackfillDieselPrices: 'BLOCKED: deploy a governed diesel-backfill callable (only triggerDieselFetch/weeklyDieselPriceFetch exist).',
  staffRetireLegacyDriverLogin: 'BLOCKED: driver-identity lane (Laptop ChatGPT) — deploy retire-legacy-login callable.',
  staffHydrateCanonicalIdentity: 'BLOCKED: driver-identity lane (Laptop ChatGPT) — deploy hydrate-canonical-identity callable.',
};

/** Callable names reached via a constant/adapter, not a string literal in the httpsCallable call. */
const KNOWN_INDIRECT_CALLABLES = ['adminSubmitPullEdit'];

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true, recursive: true }) as Array<{ name: string; parentPath?: string; path?: string; isFile(): boolean }>) {
    if (!ent.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(ent.name)) continue;
    if (ent.name.endsWith('.test.ts') || ent.name.endsWith('.test.tsx')) continue;
    const base = (ent.parentPath ?? ent.path ?? dir);
    out.push(`${base}/${ent.name}`);
  }
  return out;
}

function scanCallableLiterals(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const re = /httpsCallable\s*(?:<[^>]*>)?\s*\(\s*[^,]+,\s*'([^']+)'\s*\)/g;
  for (const file of walkTsx(SRC)) {
    const body = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const name = m[1];
      if (!found.has(name)) found.set(name, []);
      found.get(name)!.push(file.replace(SRC, 'src/'));
    }
  }
  return found;
}

test('every httpsCallable name is DEPLOYED or explicitly BLOCKED (catches missing/wrong names)', () => {
  const called = scanCallableLiterals();
  const unknown: string[] = [];
  for (const name of called.keys()) {
    if (deployedSet.has(name)) continue;
    if (name in KNOWN_BLOCKED_MISSING) continue;
    unknown.push(name);
  }
  assert.deepEqual(unknown, [], `Callable(s) neither deployed nor documented-blocked: ${unknown.join(', ')}`);
});

test('indirect (adapter/constant) callables are deployed', () => {
  for (const name of KNOWN_INDIRECT_CALLABLES) {
    assert.ok(deployedSet.has(name), `${name} must be in the deployed inventory`);
  }
});

test('BLOCKED-missing callables are genuinely absent from the deployed inventory (shrink list when backend ships)', () => {
  for (const name of Object.keys(KNOWN_BLOCKED_MISSING)) {
    assert.ok(!deployedSet.has(name), `${name} is now deployed — remove it from KNOWN_BLOCKED_MISSING and wire/verify the control.`);
  }
});

// ── governed baseline must not regress (live 2b52c0cc) ───────────────────────

test('BASELINE: governed pull edit wired to adminSubmitPullEdit; no client packets/incoming write', () => {
  const core = read('../pullEditCore.ts');
  const wrap = read('../pullEdit.ts');
  assert.match(core, /ADMIN_PULL_EDIT_CALLABLE\s*=\s*'adminSubmitPullEdit'/);
  assert.ok(!/set\s*\(\s*ref\s*\(/.test(wrap) && !/packets\/incoming\/\$\{/.test(wrap), 'pullEdit must not direct-write packets/incoming');
});

test('BASELINE: governed pull delete wired to staffDeletePull (via core constant)', () => {
  assert.match(read('../pullDeleteCore.ts'), /DELETE_PULL_CALLABLE\s*=\s*'staffDeletePull'/);
  assert.match(read('../pullDelete.ts'), /DELETE_PULL_CALLABLE/, 'wrapper uses the core constant');
  // no direct-database fallback in the wrapper
  assert.ok(!/set\s*\(\s*ref\s*\(/.test(read('../pullDelete.ts')), 'pullDelete must not direct-write RTDB');
});

test('Phase-2 adapter cores target DEPLOYED callables (delete/dispatch/dismiss)', () => {
  const grab = (rel: string, re: RegExp): string => {
    const m = re.exec(read(rel));
    assert.ok(m, `${rel} must declare its callable constant`);
    return m![1];
  };
  const names = [
    grab('../pullDeleteCore.ts', /DELETE_PULL_CALLABLE\s*=\s*'([^']+)'/),
    grab('../staffWriteDispatchCore.ts', /STAFF_WRITE_DISPATCH_CALLABLE\s*=\s*'([^']+)'/),
    grab('../dismissDispatchCore.ts', /DISMISS_DISPATCH_CALLABLE\s*=\s*'([^']+)'/),
  ];
  assert.deepEqual(names, ['staffDeletePull', 'staffWriteDispatch', 'dismissDispatch']);
  for (const n of names) assert.ok(deployedSet.has(n), `${n} must be in the deployed inventory`);
});

test('BASELINE: Photo Review approve wired to reviewDispatchPhoto; tab present', () => {
  assert.match(read('../../app/photo-review/page.tsx'), /reviewDispatchPhoto/);
  assert.match(read('../tabs.ts'), /id:\s*'photo-review'/);
});

// ── Add Well: governed, payload-compatible, NO direct-write fallback ─────────

test('Add Well: staffCreateWellConfig sends the exact create-only contract {op:create,wellName,config}', () => {
  const adapter = read('../staffWriteWellConfig.ts');
  // create adapter → op:'create'
  const createBlock = adapter.slice(adapter.indexOf('staffCreateWellConfig'), adapter.indexOf('staffUpdateWellConfig'));
  assert.match(createBlock, /httpsCallable\([^,]+,\s*'staffWriteWellConfig'\)/);
  assert.match(createBlock, /op:\s*'create'/);
  assert.match(createBlock, /wellName:/);
  assert.match(createBlock, /config:/);
});

test('Add Well: handler has NO direct-write fallback to well_config', () => {
  const admin = read('../../app/admin/page.tsx');
  const start = admin.indexOf('const handleAddWell');
  const body = admin.slice(start, admin.indexOf('const handleUpdateWell', start));
  assert.ok(start >= 0 && body.length > 0, 'handleAddWell must exist');
  assert.ok(!/set\s*\(\s*ref\s*\(\s*db\s*,\s*`?well_config/.test(body), 'handleAddWell must not direct-write well_config');
  assert.match(body, /staffCreateWellConfig\(/);
});

// ── Save Changes: CONTRACT-BLOCKED (op:update vs create-only server) ─────────

test('CONTRACT GAP: Save Changes sends op:update but deployed staffWriteWellConfig is create-only (BLOCKED)', () => {
  const adapter = read('../staffWriteWellConfig.ts');
  const updateBlock = adapter.slice(adapter.indexOf('staffUpdateWellConfig'));
  assert.match(updateBlock, /op:\s*'update'/, 'update adapter sends op:update');
  assert.ok(deployedSet.has('staffWriteWellConfig'), 'target callable is deployed (but create-only)');
  // Documented dependency: backend must add op:update support (or a staffUpdateWellConfig callable).
  // When that ships, add an emulator/contract verification and reclassify Save Changes to WORKING.
});

// ── +Add Pull: rules-denied direct write, no governed dashboard target (BLOCKED) ─

test('+Add Pull is a known rules-denied direct write (BLOCKED — no governed dashboard add-pull callable)', () => {
  const modal = read('../../components/AddPullModal.tsx');
  assert.match(modal, /set\s*\(\s*ref\s*\([^)]*packets\/incoming/, 'AddPullModal still direct-writes packets/incoming (documented BLOCKED)');
  // Neither ingestDriverPacket nor ingestWbmPull is dashboard-callable (both requireSecureDriver);
  // a governed staff add-pull callable is the backend dependency.
});

// ── REPAIRED this branch (fix/dashboard-button-runtime-20260913) ─────────────
// These controls write company fields the DEPLOYED firestore.rules allow
// (companies update permitted for authenticated callers on non-protected keys;
// doeRegion + the settings toggles are NOT in protectedCompanyKeys()). The
// defect was UI-side: failures were swallowed to console / a fake success was
// shown. Each guard below pins the honest behavior so it cannot regress. A
// passing guard is SOURCE-VERIFIED, not a WORKING claim — full click-through
// needs a live callable (= production) and a DOM runner, neither available here.

function sliceHandler(body: string, startMarker: string, endMarker: string): string {
  const start = body.indexOf(startMarker);
  assert.ok(start >= 0, `handler ${startMarker} must exist`);
  const end = body.indexOf(endMarker, start + startMarker.length);
  return body.slice(start, end > start ? end : body.length);
}

test('REPAIR: billing DOE region change surfaces failures (no swallow)', () => {
  const billing = read('../../app/billing/page.tsx');
  const h = sliceHandler(billing, 'const handleRegionChange', '\n  };');
  assert.match(h, /updateCompanyFields\(/, 'writes via updateCompanyFields (rules-allowed field-merge)');
  assert.match(h, /setError\(/, 'a failed region save must be surfaced via setError, not swallowed');
});

test('REPAIR: admin "Add Route" no longer fakes a persisted create', () => {
  const admin = read('../../app/admin/page.tsx');
  const h = sliceHandler(admin, 'const handleAddRoute', '\n  };');
  assert.ok(!/"[^"]*"\s*\+\s*['"] created['"]/.test(h) && !/`Route "\$\{routeName\}" created`/.test(h),
    'must not claim the route was "created" — routes persist only when a well is assigned');
  assert.match(h, /staged/, 'must tell the operator the route is staged until a well is assigned');
});

test('REPAIR: OperationsCard surfaces write failures for every control', () => {
  const card = read('../../components/settings/OperationsCard.tsx');
  // Single governed write path + a visible error surface.
  assert.match(card, /const saveField\s*=/, 'all controls route through one saveField helper');
  assert.match(card, /setError\(/, 'failures set an error message');
  assert.match(card, /role="alert"/, 'the error message is rendered');
  // No control may swallow to console with no user-visible surface.
  assert.ok(!/catch\s*\(\s*err\s*\)\s*\{\s*console\.error\([^)]*\);\s*\}/.test(card),
    'no bare catch→console.error-only remains');
});

test('REPAIR: PhotosCard surfaces write failures for every control', () => {
  const card = read('../../components/settings/PhotosCard.tsx');
  assert.match(card, /role="alert"/, 'the error message is rendered');
  // three write handlers, each must set the error state in its catch
  const setErrCount = (card.match(/setError\(/g) || []).length;
  assert.ok(setErrCount >= 3, `each of the 3 write handlers must surface errors (found ${setErrCount} setError calls)`);
});

// ── REPAIRED Phase 3 (fix/dashboard-settings-controls-20260913) ──────────────
// Company-settings writes go through a DIRECT updateCompanyFields (companies/{id})
// that the deployed rules allow for ANY authenticated caller on non-protected
// keys — so the client capability gate is the ONLY capability enforcement. These
// guards pin that gate. (The absence of server-side capability enforcement on
// these direct writes is a rules-lane matter, out of Dashboard scope.)

test('GATE: OperationsCard requires canEdit — controls disabled + handler guarded', () => {
  const card = read('../../components/settings/OperationsCard.tsx');
  assert.match(card, /canEdit:\s*boolean/, 'canEdit is a required prop');
  assert.match(card, /const saveField[\s\S]{0,120}if \(!canEdit\) return;/, 'saveField hard-guards on canEdit');
  assert.match(card, /const locked = !canEdit/, 'derives a locked flag');
  assert.match(card, /disabled=\{locked \|\|/, 'controls are disabled when locked');
  assert.match(card, /View-only/, 'shows a view-only notice');
  assert.match(card, /from '@\/lib\/companySettingsCore'/, 'payloads come from the tested core builders');
});

test('GATE: PhotosCard requires canEdit — controls disabled + handlers guarded', () => {
  const card = read('../../components/settings/PhotosCard.tsx');
  assert.match(card, /canEdit:\s*boolean/, 'canEdit is a required prop');
  const guards = (card.match(/if \(!canEdit\) return;/g) || []).length;
  assert.ok(guards >= 3, `all 3 write handlers hard-guard on canEdit (found ${guards})`);
  assert.match(card, /disabled=\{locked \|\|/, 'inputs/toggle disabled when locked');
  assert.match(card, /parsePositivePhotoInt/, 'uses the tested int parser');
});

test('GATE: settings page passes manageCompany to Operations + Photos cards', () => {
  const page = read('../../app/settings/page.tsx');
  assert.match(page, /<OperationsCard[^>]*canEdit=\{hasCapability\(user, 'manageCompany'/, 'OperationsCard gated by manageCompany');
  assert.match(page, /<PhotosCard[^>]*canEdit=\{hasCapability\(user, 'manageCompany'/, 'PhotosCard gated by manageCompany');
});

test('GATE: billing DOE region requires editBilling — select disabled + handler guarded', () => {
  const billing = read('../../app/billing/page.tsx');
  assert.match(billing, /const canEditBilling = hasCapability\(user, 'editBilling'/, 'derives editBilling capability');
  const h = sliceHandler(billing, 'const handleRegionChange', '\n  };');
  assert.match(h, /if \(!canEditBilling\) return;/, 'region handler hard-guards on editBilling');
  assert.match(billing, /disabled=\{!canEditBilling\}/, 'region select disabled without editBilling');
  assert.match(h, /buildDoeRegion\(/, 'payload comes from the tested core builder');
});

test('Phase-3 core builders exist and are used by the controls', () => {
  const core = read('../companySettingsCore.ts');
  for (const fn of ['runCompanyFieldWrite', 'buildBooleanToggle', 'buildInvoicingMode', 'buildDoeRegion', 'parsePositivePhotoInt', 'buildMinPhotoCount']) {
    assert.match(core, new RegExp(`export (async )?function ${fn}|export const ${fn}`), `${fn} exported from core`);
  }
});

// ── AUDIT Phase 4B (audit/dashboard-controls-20260913) gate + honesty guards ──
// Confirmed Dashboard-side defects repaired during the exhaustive audit. These
// pin the client capability gates / honest-UI states so they cannot regress.
// They are containment, not closure — the underlying writes remain server-
// exposed (rules-lane follow-up).

test('AUDIT: photo-review mutate gate is capability-based (not a role denylist)', () => {
  const p = read('../../app/photo-review/page.tsx');
  assert.match(p, /canMutate = canView && hasCapability\(user, 'createDispatch'/, 'canMutate uses createDispatch capability');
  assert.ok(!/user\.role !== 'viewer'/.test(p), 'the old single-role denylist is gone');
  // pagination uses the raw server count, not the client-filtered count
  assert.match(p, /const serverCount = \(data\.items \|\| \[\]\)\.length/);
  assert.match(p, /setHasMore\(serverCount >= limit\)/);
});

test('AUDIT: performance/route surfaces read failures (no silent empty state)', () => {
  const p = read('../../app/performance/route/page.tsx');
  assert.match(p, /const \[loadError, setLoadError\]/);
  assert.match(p, /classifiedReadFailure\('route performance'/);
  assert.match(p, /Retry/);
});

test('AUDIT: TicketDetailModal load has a catch (no permanent spinner)', () => {
  const p = read('../../components/TicketDetailModal.tsx');
  assert.match(p, /\}\)\.catch\(\(err\) => \{/, 'Promise.all chain has a .catch');
  assert.match(p, /setLoadError/);
});

test('AUDIT: home module cards are capability-gated', () => {
  const p = read('../../app/page.tsx');
  for (const cap of ['viewMobile', 'viewTickets', 'viewBilling', 'viewPayroll']) {
    assert.ok(p.includes(`hasCapability(user, '${cap}'`), `home card gated by ${cap}`);
  }
});

test('AUDIT: billing Save/Delete price gated by editBilling', () => {
  const p = read('../../app/billing/page.tsx');
  assert.match(p, /const handleSavePrice[\s\S]{0,80}if \(!canEditBilling\) return;/, 'Save Price guarded');
  assert.match(p, /disabled=\{savingPrice \|\| !newPrice \|\| !canEditBilling\}/, 'Save Price button gated');
  assert.ok(/if \(!canEditBilling\) return;\s*\n\s*if \(!confirm\(`Delete price entry/.test(p), 'Delete price handler guarded');
});

test('AUDIT: payroll money mutations gated by approvePayroll + errors surfaced', () => {
  const p = read('../../app/payroll/page.tsx');
  assert.match(p, /const canApprovePayroll = hasCapability\(user, 'approvePayroll'/);
  const guards = (p.match(/if \(!canApprovePayroll\) return;/g) || []).length;
  assert.ok(guards >= 4, `all 4 deduction/bonus handlers guarded (found ${guards})`);
  // dead buttons disabled, not silent no-ops
  assert.ok(!/onClick=\{\(\) => \{\/\* TODO/.test(p), 'no empty TODO onClick remains');
});

test('AUDIT: dispatch Projects/chat direct-writes gated by createDispatch', () => {
  const p = read('../../app/dispatch/page.tsx');
  assert.match(p, /const guardCreateDispatch = \(\) =>/, 'message-returning project guard exists');
  const guards = (p.match(/if \(!guardCreateDispatch\(\)\) return;/g) || []).length;
  assert.ok(guards >= 4, `project handlers guarded (found ${guards})`);
  assert.match(p, /\{canCreateDispatch && \(\s*<button\s+onClick=\{\(\) => setShowAddPullModal\(true\)\}/, '+Add Pull entry gated');
});

test('AUDIT: mobile +Add Pull entry gated by createDispatch', () => {
  const p = read('../../app/mobile/page.tsx');
  assert.match(p, /const canAddPull = hasCapability\(user, 'createDispatch'/);
  assert.match(p, /\{canAddPull && \(/);
});

test('AUDIT: every mutation settings card has a canEdit gate + is passed one', () => {
  const cards = [
    'CompanyProfileCard', 'PackagesCard', 'CustomJobTypesCard', 'InvoiceConfigCard',
    'LevelReportsCard', 'OilCompaniesCard', 'RateSheetsCard', 'BillingConfigCard',
    'TicketTemplateCard', 'PayConfigCard', 'PayrollTemplateCard', 'BrandingCard',
    'SWDDirectoryCard', 'JsaCard', 'OperationsCard', 'PhotosCard',
  ];
  const page = read('../../app/settings/page.tsx');
  for (const c of cards) {
    const src = read(`../../components/settings/${c}.tsx`);
    assert.match(src, /canEdit/, `${c} declares a canEdit gate`);
    // Find the card's render line and assert it is passed a manageCompany/editBilling gate.
    const line = page.split('\n').find((l) => l.includes(`<${c} `) || l.includes(`<${c}\n`) || l.trimStart().startsWith(`<${c}`));
    assert.ok(line, `${c} is rendered on the settings page`);
    assert.ok(
      line!.includes(`canEdit={hasCapability(user, 'manageCompany'`) ||
      line!.includes(`canEdit={hasCapability(user, 'editBilling'`),
      `${c} is passed a manageCompany/editBilling canEdit gate`,
    );
  }
});

// ── AUDIT Phase 4C — closing repairs (gates before adapter, honest errors) ────
test('AUDIT-4C: billing projection + config mutations all guard editBilling before writing', () => {
  const p = read('../../app/billing/page.tsx');
  const guards = (p.match(/if \(!canEditBilling\) return;/g) || []).length;
  assert.ok(guards >= 7, `region/save/delete/generate/markSent/recordPayment/backfill all guarded (found ${guards})`);
});

test('AUDIT-4C: chat mutations gated (viewChat surface, sendChat sends, manageCompany profiles)', () => {
  const page = read('../../app/chat/page.tsx');
  assert.ok(page.includes("const canViewChat = hasCapability(user, 'viewChat'"));
  assert.ok(page.includes("const canSendChat = hasCapability(user, 'sendChat'"));
  assert.ok(page.includes("const canManageProfiles = hasCapability(user, 'manageCompany'"));
  assert.ok(page.includes('if (!canViewChat)'), 'page-level view gate');
  // handler guards call hasCapability inline; render gates use the derived consts
  assert.ok((page.match(/if \(!hasCapability\(user, 'sendChat'/g) || []).length >= 4, 'send/DM/group/archive guarded');
  assert.ok((page.match(/if \(!hasCapability\(user, 'manageCompany'/g) || []).length >= 5, 'monitor-profile CRUD guarded');
  assert.ok(page.includes('&& canSendChat'), 'send affordances render-gated');
  const sidebar = read('../../components/chat/ChatSidebar.tsx');
  assert.ok(sidebar.includes("const canSendChat = hasCapability(user, 'sendChat'"));
  assert.ok(sidebar.includes('if (!canViewChat)'), 'sidebar view gate');
});

test('AUDIT-4C: admin destructive well/route writes guard capability + no longer silently fail', () => {
  const p = read('../../app/admin/page.tsx');
  assert.ok(p.includes("const canManageWells = hasCapability(user, 'manageWells'"));
  assert.ok(p.includes("const canManageRoutes = hasCapability(user, 'manageRoutes'"));
  // delete-well handler: capability guard + a try/catch (was silent)
  const delWell = p.slice(p.indexOf('const executeDeleteWellWithAction'));
  const delWellBody = delWell.slice(0, delWell.indexOf('\n  };') + 4);
  assert.ok(/if \(!canManageWells\)/.test(delWellBody), 'delete-well guarded');
  assert.ok(/catch/.test(delWellBody), 'delete-well has try/catch');
  const delRoute = p.slice(p.indexOf('const executeDeleteRouteWithAction'));
  const delRouteBody = delRoute.slice(0, delRoute.indexOf('\n  };') + 4);
  assert.ok(/if \(!canManageRoutes\)/.test(delRouteBody), 'delete-route guarded');
  assert.ok(/catch/.test(delRouteBody), 'delete-route has try/catch');
});

test('AUDIT-4C: GPS recording + equipment + branding + seed controls gated', () => {
  const gps = read('../../components/admin/GpsRoutesTab.tsx');
  assert.ok(gps.includes("const canManageRoutes = hasCapability(user, 'manageRoutes'"));
  assert.ok((gps.match(/if \(!canManageRoutes\)/g) || []).length >= 1);
  const equip = read('../../components/admin/EquipmentTab.tsx');
  assert.ok(equip.includes("const canManageEquipment = hasCapability(user, 'manageEquipment'"));
  assert.ok(/if \(!canManageEquipment\)/.test(equip), 'equipment mutations guarded');
  const comp = read('../../components/admin/CompaniesTab.tsx');
  assert.ok(comp.includes("const canManageCompany = hasCapability(user, 'manageCompany'"));
  assert.ok(/if \(!canManageCompany\)/.test(comp), 'branding save guarded');
  const seed = read('../../components/settings/JobTypeRnDCard.tsx');
  assert.ok(/const canSeed = isPlatformAdmin\(user\)/.test(seed), 'seed gated to platform admin');
  assert.ok(/if \(!canSeed\)/.test(seed) && /confirm\(/.test(seed), 'seed guarded + confirm');
});
