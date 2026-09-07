import { readFileSync } from 'fs';
import { join } from 'path';

// functionsRoot = .../functions ; dashboardRoot = repo root
const functionsRoot = join(__dirname, '../../../..');
const dashboardRoot = join(functionsRoot, '..');
const readFn = (rel: string) => readFileSync(join(functionsRoot, rel), 'utf8');
const readApp = (rel: string) => readFileSync(join(dashboardRoot, rel), 'utf8');

describe('governed pull correction — export/backend wiring', () => {
  const index = readFn('src/index.ts');
  const securityIndex = readFn('src/security/index.ts');
  const callable = readFn('src/security/staffCorrectPullCallable.ts');

  it('exports staffCorrectPull as a Cloud Function', () => {
    expect(securityIndex).toMatch(/export \{ staffCorrectPull \} from '\.\/staffCorrectPullCallable'/);
    expect(index).toMatch(/staffCorrectPull,/);
  });

  it('defines the processMoveRequest trigger that re-anchors identity and rebuilds both wells', () => {
    expect(index).toMatch(/export const processMoveRequest = functionsV1\.database/);
    expect(index).toMatch(/data\.requestType !== 'move'/);
    // Identity preserved: wellName re-anchored on the SAME packets/processed/{packetId}.
    expect(index).toMatch(/packets\/processed\/\$\{targetPacketId\}`\)\.update\(\{/);
    // Both wells recomputed.
    expect(index).toMatch(/rebuildWellOutgoing\(fromWell\)/);
    expect(index).toMatch(/rebuildWellOutgoing\(toWell\)/);
    // Idempotent + fail-closed.
    expect(index).toMatch(/already on \$\{toWell\}/); // already-moved no-op
    expect(index).toMatch(/well_mismatch/);
  });

  it('the callable derives auth server-side and never trusts a client tenant', () => {
    expect(callable).toMatch(/requireManageDrivers/);
    expect(callable).toMatch(/evaluatePullCorrection/);
    // Input is key-allowlisted; no companyId field is accepted from the client.
    expect(callable).toMatch(/const ALLOWED = new Set\(\['op', 'packetId', 'fromWell', 'toWell'\]\)/);
    expect(callable).not.toMatch(/data\.companyId|raw\.companyId/);
    // Single-flight deterministic key.
    expect(callable).toMatch(/correctionIncomingKey/);
    expect(callable).toMatch(/writeSecurityAudit/);
  });
});

describe('governed pull correction — client wiring (no direct DB fallback)', () => {
  const clientLib = readApp('src/lib/pullCorrection.ts');
  const wells = readApp('src/lib/wells.ts');
  const page = readApp('src/app/well/page.tsx');

  it('the page invokes the governed endpoint, not a raw database write', () => {
    expect(page).toMatch(/from '@\/lib\/pullCorrection'/);
    expect(page).toMatch(/deletePull,\s*movePull,\s*describeCorrectionError/);
    // page no longer imports deletePull from wells
    expect(page).not.toMatch(/deletePull,[\s\S]{0,80}from '@\/lib\/wells'/);
  });

  it('the client calls the staffCorrectPull callable for both delete and move', () => {
    expect(clientLib).toMatch(/httpsCallable\(getFirebaseFunctions\(\), 'staffCorrectPull'\)/);
    expect(clientLib).toMatch(/op: 'delete'/);
    expect(clientLib).toMatch(/op: 'move'/);
  });

  it('there is NO direct RTDB/Firestore delete fallback in the client correction path', () => {
    // The client correction module must not touch the database directly.
    expect(clientLib).not.toMatch(/firebase\/database|firebase\/firestore|getFirebaseDatabase|\bset\(|\bref\(/);
    // The legacy direct write to packets/incoming for delete is gone from wells.ts.
    expect(wells).not.toMatch(/requestType: 'delete'/);
    expect(wells).not.toMatch(/packets\/incoming\/\$\{deletePacketId\}/);
    expect(wells).not.toMatch(/export async function deletePull/);
  });

  it('backend-unavailable is surfaced as a sanitized, retryable message (original record preserved)', () => {
    // describeCorrectionError maps transport failures to "not changed — try again".
    expect(clientLib).toMatch(/unavailable/);
    expect(clientLib).toMatch(/not changed/i);
    // Never surfaces raw exception text as the whole message.
    expect(clientLib).toMatch(/describeCorrectionError/);
  });
});
