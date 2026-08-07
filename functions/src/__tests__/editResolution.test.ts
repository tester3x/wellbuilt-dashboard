// Exact invoice-identity edit resolution (7/25, ticket 19852).
//
// The client's Depart minted twin packet ids; the processed pull was
// `…_7guae0` while the invoice persisted the stale-rejected `…_q1jwti`.
// The close EDIT (140→165) targeted the phantom and was quarantined
// ORIGINAL_PACKET_NOT_FOUND even though both records carry the same
// immutable invoiceDocId. resolveEditTarget adds ONE safe fallback:
// exact-invoiceDocId, exactly-one-candidate — never guessing.
import {
  EditResolutionDb,
  ambiguousEditVerdict,
  resolveEditTarget,
} from '../packetGuards';

const PROCESSED_ID = '20260725_132315_GABRIEL1-36-25H_7guae0';
const PHANTOM_ID = '20260725_132315_GABRIEL1-36-25H_q1jwti';
const INVOICE = 'bosYvJhlcbM48av8qONh';

const processedPull = {
  packetId: PROCESSED_ID,
  requestType: 'pull',
  wellName: 'Gabriel 1',
  invoiceDocId: INVOICE,
  dateTimeUTC: '2026-07-25T18:23:15.646Z',
  tankLevelFeet: 11.916666666666666,
  bblsTaken: 140,
};

function makeDb(
  processed: Record<string, Record<string, unknown>>,
): EditResolutionDb & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async readProcessed(pid) {
      return processed[pid] ?? null;
    },
    async queryProcessedByInvoiceDocId(inv) {
      queries.push(inv);
      return Object.entries(processed)
        .filter(([, v]) => v.invoiceDocId === inv)
        .map(([key, val]) => ({ key, val }));
    },
  };
}

describe('resolveEditTarget', () => {
  test('1. valid originalPacketId resolves exactly — behavior unchanged', async () => {
    const db = makeDb({ [PROCESSED_ID]: processedPull });
    const r = await resolveEditTarget(db, PROCESSED_ID, INVOICE);
    expect(r).toEqual({ kind: 'exact', packetId: PROCESSED_ID, packet: processedPull });
    // Exact hits never even run the fallback query.
    expect(db.queries).toHaveLength(0);
  });

  test('2. missing id + exactly one invoiceDocId candidate → fallback resolves', async () => {
    const db = makeDb({ [PROCESSED_ID]: processedPull });
    const r = await resolveEditTarget(db, PHANTOM_ID, INVOICE);
    expect(r.kind).toBe('fallback');
    if (r.kind === 'fallback') {
      // 7. the PROCESSED pull's id remains canonical — never the phantom.
      expect(r.packetId).toBe(PROCESSED_ID);
      expect(r.packet).toBe(processedPull);
    }
  });

  test('3. missing id + zero candidates → not_found (orphan quarantine preserved)', async () => {
    const db = makeDb({});
    const r = await resolveEditTarget(db, PHANTOM_ID, INVOICE);
    expect(r).toEqual({ kind: 'not_found' });
  });

  test('4. missing id + MULTIPLE candidates → ambiguous, never guessed', async () => {
    const twin = { ...processedPull, packetId: 'OTHER_PULL', dateTimeUTC: '2026-07-25T19:00:00.000Z' };
    const db = makeDb({ [PROCESSED_ID]: processedPull, OTHER_PULL: twin });
    const r = await resolveEditTarget(db, PHANTOM_ID, INVOICE);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.candidateIds.sort()).toEqual(['OTHER_PULL', PROCESSED_ID].sort());
    }
    const verdict = ambiguousEditVerdict(PHANTOM_ID, INVOICE, ['A', 'B']);
    expect(verdict.action).toBe('quarantine');
    expect(verdict.reason).toBe('AMBIGUOUS_EDIT_TARGET');
    expect(verdict.readableReason).toContain('refusing to guess');
  });

  test('5. no timestamp / well-name / driver / quantity guessing exists', async () => {
    // A same-well, same-time, same-quantity pull with a DIFFERENT invoice
    // never matches — the ONLY fallback key is exact invoiceDocId.
    const decoy = { ...processedPull, invoiceDocId: 'differentInvoice' };
    const db = makeDb({ [PROCESSED_ID]: decoy });
    const r = await resolveEditTarget(db, PHANTOM_ID, INVOICE);
    expect(r).toEqual({ kind: 'not_found' });
    // Missing/blank invoiceDocId → no query at all.
    const db2 = makeDb({ [PROCESSED_ID]: processedPull });
    expect(await resolveEditTarget(db2, PHANTOM_ID, '')).toEqual({ kind: 'not_found' });
    expect(await resolveEditTarget(db2, PHANTOM_ID, undefined)).toEqual({ kind: 'not_found' });
    expect(db2.queries).toHaveLength(0);
  });

  test('6. fallback resolution never creates a new pull', async () => {
    // resolveEditTarget is read-only by type: the injectable surface exposes
    // reads only, so no resolution outcome can mint a record.
    const db = makeDb({ [PROCESSED_ID]: processedPull });
    const before = JSON.stringify(processedPull);
    await resolveEditTarget(db, PHANTOM_ID, INVOICE);
    expect(JSON.stringify(processedPull)).toBe(before);
    const surface = Object.keys(db).filter((k) => k !== 'queries');
    expect(surface.sort()).toEqual(['queryProcessedByInvoiceDocId', 'readProcessed']);
  });

  test('8. 19852 reproduction: q1jwti edit resolves to 7guae0', async () => {
    const db = makeDb({ [PROCESSED_ID]: processedPull });
    const r = await resolveEditTarget(db, PHANTOM_ID, INVOICE);
    expect(r.kind).toBe('fallback');
    if (r.kind === 'fallback') expect(r.packetId).toBe(PROCESSED_ID);
  });

  test('9. non-pull artifacts sharing the invoiceDocId never match', async () => {
    const artifact = { requestType: 'edit', invoiceDocId: INVOICE };
    const db = makeDb({ [PROCESSED_ID]: processedPull, ARTIFACT: artifact });
    const r = await resolveEditTarget(db, PHANTOM_ID, INVOICE);
    expect(r.kind).toBe('fallback');
    if (r.kind === 'fallback') expect(r.packetId).toBe(PROCESSED_ID);
  });

  test('10. retry of the same fallback edit is idempotent (same resolution)', async () => {
    const db = makeDb({ [PROCESSED_ID]: processedPull });
    const r1 = await resolveEditTarget(db, PHANTOM_ID, INVOICE);
    const r2 = await resolveEditTarget(db, PHANTOM_ID, INVOICE);
    expect(r1).toEqual(r2);
  });
});

describe('processEditRequest wiring (structural)', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export const processEditRequest'));

  test('resolution runs before quarantine decisions; canonical id flows downstream', () => {
    expect(fn).toContain('resolveEditTarget(');
    expect(fn).toContain("resolution.kind === 'not_found'");
    expect(fn).toContain("resolution.kind === 'ambiguous'");
    expect(fn).toContain('const originalPacketId = resolution.packetId;');
  });

  test('fallback stamps audit fields, never the phantom as identity', () => {
    expect(fn).toContain("editResolvedVia: 'invoiceDocId_fallback'");
    expect(fn).toContain('editRequestedPacketId: requestedPacketId');
    expect(fn).toContain('...fallbackAuditFields');
    // No write path uses the requested id as a record identity.
    expect(fn).not.toMatch(/packets\/(processed|incoming)\/\$\{requestedPacketId\}`\)\.(update|set)/);
  });

  test('bounded indexed lookup: invoiceDocId is in the processed .indexOn', () => {
    const rules = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', '..', 'database.rules.json'), 'utf8'),
    );
    expect(rules.rules.packets.processed['.indexOn']).toContain('invoiceDocId');
  });
});
