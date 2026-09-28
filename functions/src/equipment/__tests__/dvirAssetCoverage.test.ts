import { evaluateDvirAssetCoverage, type DvirAssetCoverageInput, type TrustedDvirAssetRow } from '../dvirAssetCoverage';

const OPEN = {
  state: 'open' as const,
  companyId: 'co-1',
  driverId: 'drv-1',
  periodId: '2026-09-27_080000',
};

const TRUCK = { role: 'truck' as const, equipmentId: 'eq-truck-1' };
const TRAILER = { role: 'trailer' as const, equipmentId: 'eq-trailer-9' };

function row(over: Partial<TrustedDvirAssetRow> = {}): TrustedDvirAssetRow {
  return {
    companyId: 'co-1',
    driverId: 'drv-1',
    periodId: '2026-09-27_080000',
    phase: 'pre_trip',
    role: 'truck',
    equipmentId: 'eq-truck-1',
    inspectionId: 'insp-1',
    acceptedAtMs: 100,
    result: 'pass',
    status: 'accepted',
    ...over,
  };
}

function input(over: Partial<DvirAssetCoverageInput> = {}): DvirAssetCoverageInput {
  return {
    phase: 'pre_trip',
    authority: OPEN,
    assets: [TRUCK, TRAILER],
    rows: [
      row(),
      row({ role: 'trailer', equipmentId: 'eq-trailer-9', inspectionId: 'insp-t', acceptedAtMs: 110 }),
    ],
    ...over,
  };
}

describe('evaluateDvirAssetCoverage', () => {
  it('covers a matching truck and trailer independently', () => {
    const decision = evaluateDvirAssetCoverage(input());
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.assets).toEqual([
      expect.objectContaining({ role: 'truck', equipmentId: 'eq-truck-1', covered: true, reason: 'accepted', inspectionId: 'insp-1', result: 'pass' }),
      expect.objectContaining({ role: 'trailer', equipmentId: 'eq-trailer-9', covered: true, reason: 'accepted', inspectionId: 'insp-t' }),
    ]);
    expect(decision).not.toHaveProperty('verified');
  });

  it('keeps truck coverage when only the trailer is replaced', () => {
    const decision = evaluateDvirAssetCoverage(input({
      assets: [TRUCK, { role: 'trailer', equipmentId: 'eq-trailer-new' }],
    }));
    expect(decision.ok && decision.assets).toEqual([
      expect.objectContaining({ role: 'truck', covered: true, inspectionId: 'insp-1' }),
      expect.objectContaining({ role: 'trailer', equipmentId: 'eq-trailer-new', covered: false, reason: 'not_inspected' }),
    ]);
  });

  it('keeps trailer coverage when only the truck is replaced', () => {
    const decision = evaluateDvirAssetCoverage(input({
      assets: [{ role: 'truck', equipmentId: 'eq-truck-new' }, TRAILER],
    }));
    expect(decision.ok && decision.assets).toEqual([
      expect.objectContaining({ role: 'truck', equipmentId: 'eq-truck-new', covered: false, reason: 'not_inspected' }),
      expect.objectContaining({ role: 'trailer', covered: true, inspectionId: 'insp-t' }),
    ]);
  });

  it('returns no asset decisions when none are requested', () => {
    const decision = evaluateDvirAssetCoverage(input({ assets: [], rows: [] }));
    expect(decision).toEqual({
      ok: true,
      phase: 'pre_trip',
      period: { state: 'open', periodId: OPEN.periodId },
      assets: [],
    });
  });

  it('does not cover a foreign or missing period', () => {
    const foreign = evaluateDvirAssetCoverage(input({
      rows: [row({ periodId: '2026-09-26_080000' }), row({ role: 'trailer', equipmentId: 'eq-trailer-9', periodId: '2026-09-26_080000' })],
    }));
    expect(foreign.ok && foreign.assets.every((asset) => asset.covered === false && asset.reason === 'identity_mismatch')).toBe(true);

    const missing = evaluateDvirAssetCoverage(input({
      authority: { state: 'unavailable' },
    }));
    expect(missing.ok && missing.period).toEqual({ state: 'unavailable' });
    expect(missing.ok && missing.assets.every((asset) => asset.reason === 'authority_unavailable' && asset.covered === false)).toBe(true);
  });

  it('rejects company and driver mismatches', () => {
    const decision = evaluateDvirAssetCoverage(input({
      rows: [
        row({ companyId: 'other-co' }),
        row({ role: 'trailer', equipmentId: 'eq-trailer-9', driverId: 'other-drv' }),
      ],
    }));
    expect(decision.ok && decision.assets.map((asset) => asset.reason)).toEqual(['identity_mismatch', 'identity_mismatch']);
  });

  it('does not let a trailer row cover the same equipment id requested as a truck', () => {
    const decision = evaluateDvirAssetCoverage(input({
      assets: [{ role: 'truck', equipmentId: 'eq-shared' }],
      rows: [row({ role: 'trailer', equipmentId: 'eq-shared', inspectionId: 'insp-role' })],
    }));
    expect(decision.ok && decision.assets).toEqual([
      expect.objectContaining({ covered: false, reason: 'role_mismatch' }),
    ]);
  });

  it('picks the newest accepted row and ignores a newer void', () => {
    const older = row({ inspectionId: 'insp-old', acceptedAtMs: 50 });
    const newer = row({ inspectionId: 'insp-new', acceptedAtMs: 200 });
    const replay = evaluateDvirAssetCoverage(input({
      assets: [TRUCK],
      rows: [newer, older, newer],
    }));
    const again = evaluateDvirAssetCoverage(input({
      assets: [TRUCK],
      rows: [older, newer, newer],
    }));
    expect(replay).toEqual(again);
    expect(replay.ok && replay.assets[0]).toEqual(expect.objectContaining({
      covered: true, inspectionId: 'insp-new', acceptedAtMs: 200,
    }));

    const voidedNewer = evaluateDvirAssetCoverage(input({
      assets: [TRUCK],
      rows: [older, row({ inspectionId: 'insp-void', acceptedAtMs: 300, status: 'voided' })],
    }));
    expect(voidedNewer.ok && voidedNewer.assets[0]).toEqual(expect.objectContaining({
      covered: true, inspectionId: 'insp-old', reason: 'accepted',
    }));
  });

  it('treats needs_attention as inspected and a stale result as not coverage', () => {
    const attention = evaluateDvirAssetCoverage(input({
      assets: [TRUCK],
      rows: [row({ result: 'needs_attention', inspectionId: 'insp-attn' })],
    }));
    expect(attention.ok && attention.assets[0]).toEqual(expect.objectContaining({
      covered: true, reason: 'accepted', result: 'needs_attention',
    }));

    const stale = evaluateDvirAssetCoverage(input({
      assets: [TRUCK],
      rows: [row({ result: 'out_of_service' as 'pass' })],
    }));
    expect(stale.ok && stale.assets[0]).toEqual(expect.objectContaining({
      covered: false, reason: 'stale_result',
    }));
  });

  it('fails closed on malformed input and ignores a client verified flag', () => {
    expect(evaluateDvirAssetCoverage(input({
      assets: [TRUCK, { role: 'truck', equipmentId: 'eq-other' }],
    }))).toEqual({ ok: false, reason: 'malformed' });
    expect(evaluateDvirAssetCoverage(input({
      assets: [{ role: 'truck', equipmentId: '  ' }],
    }))).toEqual({ ok: false, reason: 'malformed' });

    const honest = input({ assets: [TRUCK], rows: [] });
    const hostile = { ...honest, verified: true, companyId: 'attacker', driverId: 'attacker' };
    const hostileDecision = evaluateDvirAssetCoverage(hostile);
    expect(hostileDecision).toEqual(evaluateDvirAssetCoverage(honest));
    expect(hostileDecision.ok && hostileDecision.assets[0].covered).toBe(false);

    const unitRow = row({ equipmentId: 'truck_12' });
    const canonical = evaluateDvirAssetCoverage(input({
      assets: [TRUCK],
      rows: [unitRow],
    }));
    expect(canonical.ok && canonical.assets[0]).toEqual(expect.objectContaining({
      covered: false,
      reason: 'not_inspected',
      equipmentId: 'eq-truck-1',
    }));
  });

  it('does not cover from a voided-only row', () => {
    const decision = evaluateDvirAssetCoverage(input({
      assets: [TRUCK],
      rows: [row({ status: 'voided' })],
    }));
    expect(decision.ok && decision.assets[0]).toEqual(expect.objectContaining({
      covered: false, reason: 'voided',
    }));
  });
});
