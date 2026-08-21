import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

function walk(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!['node_modules', '__tests__', 'lib'].includes(ent.name)) walk(p, acc);
    } else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

const re =
  /export const (\w+)\s*=\s*(httpsV2\.(onCall|onRequest)|functionsV2\.onSchedule|functionsV1\.https\.onCall|functionsV1\.database|functionsV1\.firestore)/g;
const rows = [];
for (const f of walk(join('src'))) {
  const t = readFileSync(f, 'utf8');
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(t))) rows.push({ name: m[1], kind: m[2] });
}
rows.sort((a, b) => a.name.localeCompare(b.name));

const proto = new Set([
  'authenticateDriver',
  'requestDriverRegistration',
  'checkDriverRegistrationStatus',
  'ssoExchangeAuthorizationCode',
  'getPublicClientMeta',
]);
const retired = new Set([
  'registerStandaloneDriver',
  'addSplitLeg',
  'parseJsaPdf',
  'validatePhotoCompliance',
  'suggestPhotoCriteria',
  'triggerDieselFetch',
  'writeDiagnosticLog',
  'createOrFindDispatchThread',
  'backfillTransferredTickets',
]);
const platform = new Set([
  'runTransferRequestExpiryOnDemand',
  'runMaterializerDriftScanOnDemand',
  'triggerWellCatalogRefresh',
]);

const lines = rows.map((r) => {
  let auth = 'callable_auth_required';
  let status = 'secured';
  if (r.kind.includes('onSchedule') || r.kind.includes('database') || r.kind.includes('firestore')) {
    auth = 'trigger';
    status = 'trigger';
  }
  if (r.kind.includes('onRequest')) {
    auth = 'http_bearer_required';
    status = 'fail_closed_blocker';
  }
  if (proto.has(r.name)) {
    auth = 'public_protocol';
    status = 'protocol_exception';
  }
  if (retired.has(r.name)) status = 'fail_closed_blocker';
  if (platform.has(r.name)) {
    status = 'secured';
    auth = 'platform_admin';
  }
  if (r.name === 'ssoIssueAuthorizationCode') {
    auth = 'callable_auth_required';
    status = 'secured';
  }
  return `  { name: ${JSON.stringify(r.name)}, kind: ${JSON.stringify(r.kind)}, auth: ${JSON.stringify(auth)}, status: ${JSON.stringify(status)} },`;
});

const src = `export type InventoryStatus = 'secured' | 'fail_closed_blocker' | 'protocol_exception' | 'trigger';
export interface HttpsInventoryEntry { name: string; kind: string; auth: string; status: InventoryStatus; }
export const HTTPS_INVENTORY: HttpsInventoryEntry[] = [
${lines.join('\n')}
];
export function inventoryByName(name: string) { return HTTPS_INVENTORY.find((e) => e.name === name); }
`;
writeFileSync(join('src', 'security', 'httpsInventory.ts'), src);
console.log('wrote', rows.length);
