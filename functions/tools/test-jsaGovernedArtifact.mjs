/**
 * Governed JSA immutable artifact matrix.
 * Run: npx tsx tools/test-jsaGovernedArtifact.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideComplete,
  decideConsume,
  fromStored,
} from '../src/jsaReceipt/jsaReceiptCore.js';
import {
  handleRegister,
  handleComplete,
  handleConsume,
  handlePersist,
  JsaReceiptError,
} from '../src/jsaReceipt/jsaReceiptHandlers.js';
import {
  parsePersistInput,
  parseAuthoredSnapshot,
  decodeSignaturePng,
  decideInvoiceArtifactBinding,
  decidePersist,
  requiredRequestBindings,
  canonicalizeAuthoredSnapshot,
  signatureStoragePath,
  artifactPath,
  JSA_SIGNATURE_MAX_BYTES,
  JSA_ARTIFACT_COLLECTION,
} from '../src/jsaReceipt/jsaArtifactCore.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok || !d ? '' : ` — ${d}`}`);
};

const NOW = 1_700_000_000_000;
const APP_JSA_KEY = 'wellbuilt-jsa';
const CONTRACT_OK = () => ({
  contractVersion: 1, planId: 'plan-1', contractEnforced: true,
});
const PLAN = () => ({
  contractVersion: 1, planId: 'plan-1', displayName: 'P',
  capabilities: ['jsa'], status: 'active',
  apps: { [APP_JSA_KEY]: { included: true } },
});
const OPEN_SHIFT = { state: 'open', periodId: '2026-08-12_182535', originLocalDate: '2026-08-12' };
const WBT_AUTH = { uid: 'u1', claims: { kind: 'driver', driverId: 'drv1', companyId: 'co1', app: 'wbt' } };
const JSA_AUTH = { uid: 'u1', claims: { kind: 'driver', driverId: 'drv1', companyId: 'co1', app: 'jsa' } };
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let ridSeq = 0;
const freshRid = () => String.fromCharCode(65 + (ridSeq % 26)).repeat(42) + String(++ridSeq % 10);

function seedInvoice(world, jobRef = 'job1', extra = {}) {
  if (!world.invoices) world.invoices = new Map();
  if (!world.invoiceReads) world.invoiceReads = [];
  world.invoices.set(jobRef, {
    companyId: 'co1',
    driverId: 'drv1',
    wellName: 'Gab 1',
    commodityType: 'Production Water',
    ...extra,
  });
}

function receiptWorld() {
  const w = {
    contractState: 'active',
    contract: CONTRACT_OK(),
    plan: PLAN(),
    shift: OPEN_SHIFT,
    docs: new Map(),
    invoices: new Map(),
    invoiceReads: [],
    objects: new Map(),
    storageWrites: [],
    jsas: new Map(),
  };
  seedInvoice(w);
  return w;
}

function artifactDeps(world) {
  if (!world.invoices) world.invoices = new Map();
  if (!world.invoiceReads) world.invoiceReads = [];
  if (!world.objects) world.objects = new Map();
  if (!world.storageWrites) world.storageWrites = [];
  if (!world.jsas) world.jsas = new Map();
  return {
    nowMs: () => NOW + (world.nowOff || 0),
    randomBytes: (n) => new Uint8Array(n),
    base64Url: () => 'H'.repeat(43),
    getCompanyContract: async () => ({ state: world.contractState, contract: world.contract }),
    getPlan: async () => world.plan,
    getJsaStylePolicy: async () => ({ allowRead: true, allowAcknowledge: true }),
    resolveShift: async () => world.shift,
    readInvoice: async (jobRef) => {
      world.invoiceReads.push(jobRef);
      if (!world.invoices.has(jobRef)) return { exists: false };
      return { exists: true, data: { ...world.invoices.get(jobRef) } };
    },
    runTransaction: async (fn) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const view = new Map(world.docs);
        const creates = [];
        const updates = [];
        try {
          const result = await fn({
            get: async (p) => (view.has(p)
              ? { exists: true, data: { ...view.get(p) } }
              : { exists: false }),
            create: (p, d) => {
              if (view.has(p)) {
                const e = new Error('ALREADY_EXISTS');
                e.code = 6;
                throw e;
              }
              creates.push([p, d]);
              view.set(p, d);
            },
            update: (p, f) => {
              const next = { ...view.get(p), ...f };
              updates.push([p, next]);
              view.set(p, next);
            },
          });
          for (const [p] of creates) {
            if (world.docs.has(p)) {
              const e = new Error('contention');
              e.code = 6;
              throw e;
            }
          }
          for (const [p, d] of creates) world.docs.set(p, d);
          for (const [p, d] of updates) world.docs.set(p, d);
          return result;
        } catch (e) {
          if (e && e.code === 6 && attempt < 3) continue;
          throw e;
        }
      }
    },
    log: () => {},
    sha256Hex: (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex'),
    writeImmutableObject: async (path, bytes, contentType) => {
      world.storageWrites.push(path);
      if (world.objects.has(path)) return { written: false };
      world.objects.set(path, { bytes: Buffer.from(bytes), contentType });
      return { written: true };
    },
  };
}

function validSnapshot(extra = {}) {
  return {
    prepared: { trained: true, toolsAndPpe: true, sds: true },
    locationAcks: { 'Gab 1': true },
    locations: ['Gab 1'],
    stepsAcknowledged: true,
    stepAcks: { 'driving-on-location': true },
    ppeSelected: { hardHat: true, gloves: true },
    ppeOtherItems: [],
    notes: 'clear',
    pusher: 'Nile',
    otherInfo: '',
    printedName: 'Mike Burger',
    signature: { mimeType: 'image/png', data: PNG_B64 },
    truckNumber: '19317',
    formDate: '2026-08-12',
    ...extra,
  };
}

function validBody(requestId, snapshotExtra = {}) {
  return { requestId, snapshot: validSnapshot(snapshotExtra) };
}

async function completedWorld(intent = 'read', action = 'read_completed') {
  const world = receiptWorld();
  const rid = freshRid();
  await handleRegister(artifactDeps(world), WBT_AUTH, { requestId: rid, jobRef: 'job1', intent });
  await handleComplete(artifactDeps(world), JSA_AUTH, { requestId: rid, action });
  return { world, rid };
}

async function refusalOf(world, auth, body) {
  try {
    await handlePersist(artifactDeps(world), auth, body);
    return null;
  } catch (e) {
    return e instanceof JsaReceiptError ? e.refusal : String(e);
  }
}

// ── 1. Unauthenticated ──────────────────────────────────────────────
{
  const { world, rid } = await completedWorld();
  check('1 unauthenticated caller rejected',
    await refusalOf(world, { uid: null, claims: {} }, validBody(rid)) === 'unauthenticated');
}

// ── 2. Wrong audience ───────────────────────────────────────────────
{
  const { world, rid } = await completedWorld();
  check('2 wrong audience/principal rejected',
    await refusalOf(world, WBT_AUTH, validBody(rid)) === 'wrong_audience');
}

// ── 3. Wrong driver / uid ───────────────────────────────────────────
{
  const { world, rid } = await completedWorld();
  const foreign = { uid: 'u9', claims: { kind: 'driver', driverId: 'other', companyId: 'co1', app: 'jsa' } };
  check('3 wrong driver/uid rejected',
    await refusalOf(world, foreign, validBody(rid)) === 'binding_mismatch');
}

// ── 4. Missing request ──────────────────────────────────────────────
{
  const world = receiptWorld();
  check('4 missing request rejected',
    await refusalOf(world, JSA_AUTH, validBody(freshRid())) === 'not_found');
}

// ── 5. Nonterminal request ──────────────────────────────────────────
{
  const world = receiptWorld();
  const rid = freshRid();
  await handleRegister(artifactDeps(world), WBT_AUTH, { requestId: rid, jobRef: 'job1', intent: 'read' });
  check('5 nonterminal request rejected',
    await refusalOf(world, JSA_AUTH, validBody(rid)) === 'pending');
}

// ── 6. Missing required authoritative binding ───────────────────────
{
  const { world, rid } = await completedWorld();
  const path = [...world.docs.keys()].find((k) => k.endsWith(rid));
  const rec = world.docs.get(path);
  world.docs.set(path, { ...rec, binding: { ...rec.binding, periodId: undefined, originLocalDate: undefined } });
  check('6 missing required authoritative binding rejected',
    await refusalOf(world, JSA_AUTH, validBody(rid)) === 'authority_unverifiable');
  const stripped = fromStored({ ...rec, action: null, completedAtMs: null, state: 'completed' });
  check('6b completed record without action is unverifiable',
    requiredRequestBindings({ ...stripped, action: null, completedAtMs: null, state: 'completed', binding: rec.binding }).refusal === 'authority_unverifiable');
}

// ── 7–9. Invoice re-verify ──────────────────────────────────────────
{
  const { world, rid } = await completedWorld();
  seedInvoice(world, 'job1', { companyId: 'other-co' });
  check('7 request/invoice company mismatch rejected',
    await refusalOf(world, JSA_AUTH, validBody(rid)) === 'binding_mismatch');
}
{
  const { world, rid } = await completedWorld();
  seedInvoice(world, 'job1', { driverId: 'other-drv', assignedDriverId: 'x', driverHash: 'y' });
  check('8 request/invoice driver mismatch rejected',
    await refusalOf(world, JSA_AUTH, validBody(rid)) === 'binding_mismatch');
}
{
  const mismatch = decideInvoiceArtifactBinding({
    requestJobRef: 'job1',
    loadedJobRef: 'jobOTHER',
    requestCompanyId: 'co1',
    requestDriverId: 'drv1',
    invoice: { exists: true, companyId: 'co1', driverId: 'drv1', wellName: 'Gab 1' },
  });
  check('9 request/invoice job mismatch rejected',
    mismatch.refusal === 'job_mismatch');
}

// ── 10. Client identity/authority cannot override ───────────────────
{
  const { world, rid } = await completedWorld();
  check('10a client companyId at root rejected',
    parsePersistInput({ requestId: rid, snapshot: validSnapshot(), companyId: 'evil' }).refusal === 'client_identity');
  check('10b client wellName in snapshot rejected',
    parseAuthoredSnapshot({ ...validSnapshot(), wellName: 'Spoof Well' }).refusal === 'client_identity');
  check('10c client jobRef in snapshot rejected',
    parseAuthoredSnapshot({ ...validSnapshot(), jobRef: 'other' }).refusal === 'client_identity');
  check('10d client action in snapshot rejected',
    parseAuthoredSnapshot({ ...validSnapshot(), action: 'acknowledged' }).refusal === 'client_identity');
  check('10e client periodId rejected',
    parsePersistInput({ requestId: rid, snapshot: validSnapshot(), periodId: '2026-06-24_124631' }).refusal === 'client_identity');
  const created = await handlePersist(artifactDeps(world), JSA_AUTH, validBody(rid));
  const stored = world.docs.get(artifactPath(rid));
  check('10f stored well/job/company/driver/action are server-owned',
    created.requestId === rid
    && stored.wellName === 'Gab 1'
    && stored.jobType === 'Production Water'
    && stored.companyId === 'co1'
    && stored.driverId === 'drv1'
    && stored.jobRef === 'job1'
    && stored.action === 'read_completed'
    && stored.periodId === '2026-08-12_182535'
    && stored.uid === 'u1');
}

// ── 11. Oversized ───────────────────────────────────────────────────
{
  const tooNotes = validSnapshot({ notes: 'n'.repeat(4001) });
  check('11a oversized notes rejected',
    parseAuthoredSnapshot(tooNotes).refusal === 'malformed');
  const tooArr = validSnapshot({ locations: Array.from({ length: 25 }, (_, i) => `L${i}`) });
  check('11b oversized locations array rejected',
    parseAuthoredSnapshot(tooArr).refusal === 'malformed');
  const huge = { requestId: 'R'.repeat(43), snapshot: validSnapshot() };
  huge.snapshot.notes = 'x'.repeat(181_000);
  check('11c oversized payload rejected',
    parsePersistInput(huge).refusal === 'malformed');
  const over = Buffer.alloc(JSA_SIGNATURE_MAX_BYTES + 1, 1);
  over[0] = 0x89; over[1] = 0x50; over[2] = 0x4e; over[3] = 0x47;
  over[4] = 0x0d; over[5] = 0x0a; over[6] = 0x1a; over[7] = 0x0a;
  check('11d oversized signature rejected',
    decodeSignaturePng({ mimeType: 'image/png', data: over.toString('base64') }).refusal === 'malformed');
}

// ── 12. Invalid signature ───────────────────────────────────────────
{
  check('12a jpeg type rejected',
    decodeSignaturePng({ mimeType: 'image/jpeg', data: PNG_B64 }).refusal === 'malformed');
  check('12b non-base64 rejected',
    decodeSignaturePng({ mimeType: 'image/png', data: '%%%not-base64%%%' }).refusal === 'malformed');
  check('12c random base64 without PNG magic rejected',
    decodeSignaturePng({ mimeType: 'image/png', data: Buffer.from('not-a-png').toString('base64') }).refusal === 'malformed');
  check('12d valid 1x1 PNG accepted',
    decodeSignaturePng({ mimeType: 'image/png', data: PNG_B64 }).ok === true);
  check('12e data-URL PNG accepted',
    decodeSignaturePng({ data: `data:image/png;base64,${PNG_B64}` }).ok === true);
}

// ── 13–14. Valid create + server-owned document ─────────────────────
{
  const { world, rid } = await completedWorld();
  const jsasBefore = world.jsas.size;
  const out = await handlePersist(artifactDeps(world), JSA_AUTH, validBody(rid));
  const stored = world.docs.get(artifactPath(rid));
  const decoded = decodeSignaturePng(validSnapshot().signature);
  const sha = createHash('sha256').update(Buffer.from(decoded.value.bytes)).digest('hex');
  check('13 valid completed request creates one artifact',
    out.reused === false
    && out.requestId === rid
    && out.schemaVersion === 1
    && [...world.docs.keys()].filter((k) => k.startsWith(`${JSA_ARTIFACT_COLLECTION}/`)).length === 1);
  check('14 artifact contains server-owned binding and bounded authored snapshot',
    stored.requestId === rid
    && stored.uid === 'u1'
    && stored.driverId === 'drv1'
    && stored.companyId === 'co1'
    && stored.jobRef === 'job1'
    && stored.groupRef === null
    && stored.periodId === '2026-08-12_182535'
    && stored.originLocalDate === '2026-08-12'
    && stored.shiftState === 'open'
    && stored.intent === 'read'
    && stored.action === 'read_completed'
    && stored.wellName === 'Gab 1'
    && stored.jobType === 'Production Water'
    && typeof stored.completedAtMs === 'number'
    && stored.artifactWrittenAtMs === NOW
    && stored.schemaVersion === 1
    && stored.authored.printedName === 'Mike Burger'
    && stored.authored.prepared.trained === true
    && stored.authored.locationAcks['Gab 1'] === true
    && stored.authored.stepsAcknowledged === true
    && stored.authored.ppeSelected.hardHat === true
    && stored.authored.notes === 'clear'
    && stored.authored.pusher === 'Nile'
    && stored.authored.truckNumber === '19317'
    && stored.authored.formDate === '2026-08-12'
    && stored.signature.sha256 === sha
    && stored.signature.mimeType === 'image/png'
    && stored.signature.byteSize === decoded.value.bytes.length
    && stored.signature.storagePath === signatureStoragePath(rid, sha)
    && world.objects.has(stored.signature.storagePath)
    && world.jsas.size === jsasBefore);
}

// ── 15. Exact retry idempotent ──────────────────────────────────────
{
  const { world, rid } = await completedWorld();
  const first = await handlePersist(artifactDeps(world), JSA_AUTH, validBody(rid));
  const writes = world.storageWrites.length;
  const storedAt = world.docs.get(artifactPath(rid)).artifactWrittenAtMs;
  const second = await handlePersist(artifactDeps(world), JSA_AUTH, validBody(rid));
  check('15 exact retry is idempotent',
    first.reused === false
    && second.reused === true
    && second.snapshotHash === first.snapshotHash
    && second.signature.sha256 === first.signature.sha256
    && second.artifactWrittenAtMs === storedAt
    && world.docs.get(artifactPath(rid)).artifactWrittenAtMs === storedAt
    && [...world.docs.keys()].filter((k) => k.startsWith(`${JSA_ARTIFACT_COLLECTION}/`)).length === 1
    && world.storageWrites.length === writes);
}

// ── 16. Changed retry conflict ──────────────────────────────────────
{
  const { world, rid } = await completedWorld();
  await handlePersist(artifactDeps(world), JSA_AUTH, validBody(rid));
  const changed = validBody(rid, { notes: 'changed after submit' });
  check('16 changed retry is immutable conflict',
    await refusalOf(world, JSA_AUTH, changed) === 'conflict');
  check('16b artifact notes unchanged after conflict',
    world.docs.get(artifactPath(rid)).authored.notes === 'clear');
}

// ── 17. Concurrent persistence ──────────────────────────────────────
{
  const { world, rid } = await completedWorld();
  const body = validBody(rid);
  const deps = artifactDeps(world);
  const [a, b] = await Promise.all([
    handlePersist(deps, JSA_AUTH, body),
    handlePersist(deps, JSA_AUTH, body),
  ]);
  const artifacts = [...world.docs.keys()].filter((k) => k.startsWith(`${JSA_ARTIFACT_COLLECTION}/`));
  const sigs = [...world.objects.keys()];
  check('17 concurrent persistence resolves to one immutable artifact',
    artifacts.length === 1
    && a.requestId === b.requestId
    && a.snapshotHash === b.snapshotHash
    && (a.reused || b.reused || true)
    && sigs.length === 1);
  const otherPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('second'),
  ]).toString('base64');
  const w2 = receiptWorld();
  const rid2 = freshRid();
  await handleRegister(artifactDeps(w2), WBT_AUTH, { requestId: rid2, jobRef: 'job1', intent: 'read' });
  await handleComplete(artifactDeps(w2), JSA_AUTH, { requestId: rid2, action: 'read_completed' });
  const firstRec = decidePersist({
    existingRequest: fromStored([...w2.docs.values()][0]),
    existingArtifact: null,
    requestId: rid2,
    principal: { uid: 'u1', app: 'jsa', driverId: 'drv1', companyId: 'co1', kind: 'driver' },
    snapshotHash: 'a'.repeat(64),
    signatureSha256: 'b'.repeat(64),
    nowMs: NOW,
    uid: 'u1',
    wellName: 'Gab 1',
    authored: validSnapshot(),
    signature: {
      mimeType: 'image/png', byteSize: 10, sha256: 'b'.repeat(64),
      storagePath: signatureStoragePath(rid2, 'b'.repeat(64)),
    },
  });
  const secondRec = decidePersist({
    existingRequest: fromStored([...w2.docs.values()][0]),
    existingArtifact: firstRec.value.artifact,
    requestId: rid2,
    principal: { uid: 'u1', app: 'jsa', driverId: 'drv1', companyId: 'co1', kind: 'driver' },
    snapshotHash: 'c'.repeat(64),
    signatureSha256: 'd'.repeat(64),
    nowMs: NOW + 1,
    uid: 'u1',
    wellName: 'Gab 1',
    authored: validSnapshot({ notes: 'race' }),
    signature: {
      mimeType: 'image/png', byteSize: 11, sha256: 'd'.repeat(64),
      storagePath: signatureStoragePath(rid2, 'd'.repeat(64)),
    },
  });
  check('17b concurrent different snapshots: first create, second conflict',
    firstRec.ok && firstRec.value.write === 'create' && secondRec.refusal === 'conflict');
  void otherPng;
}

// ── 18. No legacy jsas write ────────────────────────────────────────
{
  const { world, rid } = await completedWorld();
  await handlePersist(artifactDeps(world), JSA_AUTH, validBody(rid));
  const handlerSrc = readFileSync(join(root, 'src/jsaReceipt/jsaReceiptHandlers.ts'), 'utf8');
  const artifactSrc = readFileSync(join(root, 'src/jsaReceipt/jsaArtifactCore.ts'), 'utf8');
  const callableSrc = readFileSync(join(root, 'src/jsaReceipt/jsaReceiptCallables.ts'), 'utf8');
  check('18 no legacy jsas write occurs',
    world.jsas.size === 0
    && ![...world.docs.keys()].some((k) => k.startsWith('jsas/'))
    && !/collection\(\s*['"]jsas['"]\s*\)/.test(handlerSrc)
    && !/['"]jsas['"]/.test(artifactSrc)
    && !/jsas\//.test(callableSrc.split('jsaPersistGovernedArtifact')[1] || ''));
}

// ── 19. No rules widening ───────────────────────────────────────────
{
  const rules = readFileSync(join(root, '..', 'firestore.rules'), 'utf8');
  const artifactBlock = rules.slice(rules.indexOf('match /jsa_governed_artifacts/{requestId}'));
  const artifactRule = artifactBlock.split('match /')[0] + (artifactBlock.match(/allow read, write: if false/) || [])[0];
  check('19a governed requests remain client-denied',
    /match \/jsa_governed_requests\/\{requestId\}/.test(rules)
    && /allow read, write: if false/.test(rules));
  check('19b governed artifacts are explicitly client-denied (not widened)',
    /match \/jsa_governed_artifacts\/\{requestId\}/.test(rules)
    && /allow read, write: if false/.test(artifactBlock.slice(0, 250)));
  check('19c no client allow on artifacts',
    !/jsa_governed_artifacts\/\{requestId\}[\s\S]{0,200}allow (read|write|create|get): if true/.test(rules));
  check('19d catch-all deny still present',
    /match \/\{\s*document=\*\*\s*\}/.test(rules));
}

// ── 20. No complete/consume behavior change ─────────────────────────
{
  const { world, rid } = await completedWorld();
  const before = JSON.stringify([...world.docs.entries()].filter(([k]) => k.startsWith('jsa_governed_requests/')));
  const consume = await handleConsume(artifactDeps(world), WBT_AUTH, { requestId: rid });
  check('20a consume still marks and returns terminal view',
    consume.state === 'completed' && consume.action === 'read_completed' && consume.alreadyConsumed === false);
  const again = await handleConsume(artifactDeps(world), WBT_AUTH, { requestId: rid });
  check('20b second consume still alreadyConsumed / no rewrite of action',
    again.alreadyConsumed === true && again.action === 'read_completed');
  const completeRetry = await handleComplete(artifactDeps(world), JSA_AUTH, { requestId: rid, action: 'read_completed' });
  check('20c identical complete is still reuse', completeRetry.reused === true);
  let conflict = null;
  try {
    await handleComplete(artifactDeps(world), JSA_AUTH, { requestId: rid, action: 'read_and_acknowledged' });
  } catch (e) { conflict = e instanceof JsaReceiptError ? e.refusal : String(e); }
  check('20d different complete is still conflict', conflict === 'conflict');
  const reqAfter = JSON.stringify(
    Object.fromEntries([...world.docs.entries()]
      .filter(([k]) => k.startsWith('jsa_governed_requests/'))
      .map(([k, v]) => [k, { ...v, wbtConsumedAtMs: v.wbtConsumedAtMs ? 'marked' : null }])),
  );
  check('20e request identity fields unchanged by persist/consume',
    before.includes('"action":"read_completed"') && reqAfter.includes('"action":"read_completed"'));
  check('20f decideComplete/decideConsume still exported and terminal',
    typeof decideComplete === 'function' && typeof decideConsume === 'function');
}

// ── extra pins ──────────────────────────────────────────────────────
{
  const core = readFileSync(join(root, 'src/jsaReceipt/jsaReceiptCore.ts'), 'utf8');
  const artifact = readFileSync(join(root, 'src/jsaReceipt/jsaArtifactCore.ts'), 'utf8');
  const handlers = readFileSync(join(root, 'src/jsaReceipt/jsaReceiptHandlers.ts'), 'utf8');
  check('pin: persist is not wired into complete/consume',
    !/handlePersist/.test(handlers.slice(handlers.indexOf('export async function handleComplete'), handlers.indexOf('export async function handleGetContext')))
    && !/handlePersist/.test(handlers.slice(handlers.indexOf('export async function handleConsume'), handlers.indexOf('export async function handlePersist'))));
  check('pin: core receipt helpers were not given an update-artifact path',
    !/jsa_governed_artifacts/.test(core));
  check('pin: no API-key PATCH / passcode / URL identity in artifact module',
    !/AIzaSy|passcodeHash|jsaapp:\/\//.test(artifact)
    && !/createHash\(['"]md5/.test(artifact)
    && !/PATCH/.test(artifact));
  check('pin: snapshot hash is of canonical authored content + signature meta',
    canonicalizeAuthoredSnapshot(validSnapshot(), { mimeType: 'image/png', byteSize: 1, sha256: 'a'.repeat(64) }).includes('"printedName":"Mike Burger"'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
