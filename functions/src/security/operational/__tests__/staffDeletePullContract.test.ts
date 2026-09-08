import { readFileSync } from 'fs';
import { join } from 'path';

const functionsRoot = join(__dirname, '../../../..');
const dashboardRoot = join(functionsRoot, '..');
const readFn = (rel: string) => readFileSync(join(functionsRoot, rel), 'utf8');
const readApp = (rel: string) => readFileSync(join(dashboardRoot, rel), 'utf8');

describe('governed delete — server export/auth wiring', () => {
  const index = readFn('src/index.ts');
  const securityIndex = readFn('src/security/index.ts');
  const callable = readFn('src/security/staffDeletePullCallable.ts');

  it('exports staffDeletePull as a Cloud Function', () => {
    expect(securityIndex).toMatch(/export \{ staffDeletePull \} from '\.\/staffDeletePullCallable'/);
    expect(index).toMatch(/staffDeletePull,/);
  });

  it('authenticates + authorizes the actor BEFORE any write (server-derived, no client tenant)', () => {
    const authIdx = callable.indexOf('requireManageDrivers');
    const evalIdx = callable.indexOf('evaluateDeletePull');
    const txnIdx = callable.indexOf('.transaction(');
    expect(authIdx).toBeGreaterThan(-1);
    expect(evalIdx).toBeGreaterThan(authIdx);   // authorize after authenticate
    expect(txnIdx).toBeGreaterThan(evalIdx);     // write only after authorize
    // Input is key-allowlisted; the client cannot supply a company/role/tenant.
    expect(callable).toMatch(/const ALLOWED = new Set\(\['packetId', 'wellName'\]\)/);
    expect(callable).not.toMatch(/data\.companyId|raw\.companyId|raw\.role|raw\.caps/);
    // Deterministic single-flight key + audit.
    expect(callable).toMatch(/deleteIncomingKey/);
    expect(callable).toMatch(/writeSecurityAudit/);
  });

  it('routes through the existing processDeleteRequest (governed packet to packets/incoming, admin-side)', () => {
    expect(callable).toMatch(/requestType: 'delete'/);
    expect(callable).toMatch(/packets\/incoming\/\$\{key\}/);
    // processDeleteRequest still exists and is unchanged by this batch.
    expect(index).toMatch(/export const processDeleteRequest = functionsV1\.database/);
  });
});

describe('governed delete — client (no direct DB fallback, honest UI)', () => {
  const clientLib = readApp('src/lib/pullDelete.ts');
  const wells = readApp('src/lib/wells.ts');
  const page = readApp('src/app/well/page.tsx');

  it('the client calls the staffDeletePull callable and touches no database directly', () => {
    expect(clientLib).toMatch(/httpsCallable\(getFirebaseFunctions\(\), 'staffDeletePull'\)/);
    expect(clientLib).not.toMatch(/firebase\/database|firebase\/firestore|getFirebaseDatabase|\bset\(|\bref\(/);
  });

  it('the legacy direct RTDB delete write is removed from wells.ts', () => {
    expect(wells).not.toMatch(/export async function deletePull/);
    expect(wells).not.toMatch(/requestType: 'delete'/);
    expect(wells).not.toMatch(/packets\/incoming\/\$\{deletePacketId\}/);
  });

  it('the page invokes the governed endpoint, not a raw database write', () => {
    expect(page).toMatch(/from '@\/lib\/pullDelete'/);
    expect(page).toMatch(/deletePull,\s*describeDeleteError/);
    // no longer imports deletePull from wells
    expect(page).not.toMatch(/deletePull,[\s\S]{0,80}from '@\/lib\/wells'/);
  });

  it('the UI waits for callable confirmation, prevents double-submit, and surfaces rejection', () => {
    // confirmDelete awaits the callable before refreshing/closing (no optimistic removal).
    expect(page).toMatch(/await deletePull\(deletingPull\.packetId, deletingPull\.wellName\)/);
    expect(page).toMatch(/if \(deleteSubmitting\) return;/); // double-submit guard
    expect(page).toMatch(/setError\(describeDeleteError\(err\)\)/); // sanitized rejection
    // The row is refreshed from the server (fetchWellHistoryUnified), never spliced out optimistically.
    const del = page.slice(page.indexOf('const confirmDelete'), page.indexOf('const confirmDelete') + 700);
    expect(del).toMatch(/fetchWellHistoryUnified\(wellName\)/);
    expect(del).not.toMatch(/setPulls\([\s\S]{0,40}filter/); // no optimistic client-side removal
  });
});
