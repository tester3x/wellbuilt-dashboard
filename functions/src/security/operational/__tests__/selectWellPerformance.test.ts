import {
  MAX_PERFORMANCE_ROWS,
  parseWellPerformanceRequest,
  projectPerformanceRow,
  projectWellPerformance,
  isAuthorizedSnapshotWell,
  wellKeyFromName,
  WellPerformanceRequestError,
} from '../selectWellPerformance';

describe('parseWellPerformanceRequest', () => {
  it('accepts wellName plus optional ISO dates', () => {
    expect(parseWellPerformanceRequest({ wellName: 'Gabriel 1' })).toEqual({
      wellName: 'Gabriel 1',
    });
    expect(
      parseWellPerformanceRequest({
        wellName: 'Gabriel 1',
        fromDate: '2026-01-01',
        toDate: '2026-08-22',
      }),
    ).toEqual({
      wellName: 'Gabriel 1',
      fromDate: '2026-01-01',
      toDate: '2026-08-22',
    });
  });

  it('rejects unexpected keys, malformed dates, reversed ranges, and oversized strings', () => {
    const bad = (data: unknown, message: string) => {
      try {
        parseWellPerformanceRequest(data);
        throw new Error(`expected ${message}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WellPerformanceRequestError);
        expect((err as WellPerformanceRequestError).message).toBe(message);
      }
    };
    bad({ wellName: 'Gabriel 1', extra: true }, 'unexpected_key');
    bad({ wellName: 'Gabriel 1', fromDate: '08/22/2026' }, 'fromDate_malformed');
    bad({ wellName: 'Gabriel 1', toDate: '2026-8-2' }, 'toDate_malformed');
    bad(
      { wellName: 'Gabriel 1', fromDate: '2026-08-22', toDate: '2026-08-01' },
      'date_range_reversed',
    );
    bad({ wellName: 'G'.repeat(121) }, 'well_name_too_long');
    bad({ wellName: '  ' }, 'well_name_required');
    bad({}, 'well_name_required');
  });
});

describe('projectWellPerformance', () => {
  const gabrielNode = {
    wellName: 'Gabriel 1',
    updated: '2026-08-22T12:00:00.000Z',
    rows: {
      ok: { d: '2026-08-01', a: 120, p: 118, extra: 'drop-me' },
      malformed: { d: 'nope', a: 10, p: 10 },
      nonfinite: { d: '2026-08-02', a: Number.NaN, p: 10 },
      zero: { d: '2026-08-03', a: 0, p: 12 },
      nested: { d: '2026-08-10', a: 96, p: 100 },
    },
  };

  it('projects only {d,a,p} and omits malformed/nonfinite rows', () => {
    const out = projectWellPerformance({
      requestedWellName: 'Gabriel 1',
      node: gabrielNode,
    });
    expect(out.wellName).toBe('Gabriel 1');
    expect(out.updated).toBe('2026-08-22T12:00:00.000Z');
    expect(out.rows).toEqual([
      { d: '2026-08-01', a: 120, p: 118 },
      { d: '2026-08-10', a: 96, p: 100 },
    ]);
    expect(out.rows.every((row) => Object.keys(row).sort().join('') === 'adp')).toBe(true);
  });

  it('filters by fromDate/toDate without dropping 30D/90D/1Y/custom windows', () => {
    const out = projectWellPerformance({
      requestedWellName: 'Gabriel 1',
      node: gabrielNode,
      fromDate: '2026-08-05',
      toDate: '2026-08-31',
    });
    expect(out.rows).toEqual([{ d: '2026-08-10', a: 96, p: 100 }]);
  });

  it('returns empty rows for an authorized well with no data', () => {
    const out = projectWellPerformance({
      requestedWellName: 'Gabriel 1',
      node: null,
    });
    expect(out).toEqual({ wellName: 'Gabriel 1', updated: '', rows: [] });
  });

  it('caps at MAX_PERFORMANCE_ROWS keeping the most recent', () => {
    const rows: Record<string, { d: string; a: number; p: number }> = {};
    for (let i = 0; i < MAX_PERFORMANCE_ROWS + 25; i++) {
      const day = String((i % 28) + 1).padStart(2, '0');
      const year = 2000 + Math.floor(i / 365);
      rows[`r${i}`] = { d: `${year}-01-${day}`, a: 10 + (i % 5), p: 10 };
    }
    const out = projectWellPerformance({
      requestedWellName: 'Gabriel 1',
      node: { wellName: 'Gabriel 1', rows },
    });
    expect(out.rows.length).toBe(MAX_PERFORMANCE_ROWS);
    expect(out.rows[0].d <= out.rows[out.rows.length - 1].d).toBe(true);
  });
});

describe('well authorization helpers', () => {
  it('maps Gabriel 1 to performance/Gabriel_1 and requires exact snapshot membership', () => {
    expect(wellKeyFromName('Gabriel 1')).toBe('Gabriel_1');
    const wells = { 'Gabriel 1': { route: 'Gabriels' } };
    expect(isAuthorizedSnapshotWell(wells, 'Gabriel 1')).toBe(true);
    expect(isAuthorizedSnapshotWell(wells, 'Other Co 1')).toBe(false);
    expect(isAuthorizedSnapshotWell(wells, 'Gabriel 9')).toBe(false);
  });

  it('drops extra keys on a single row', () => {
    expect(projectPerformanceRow({ d: '2026-08-01', a: 10, p: 11, z: 1 })).toEqual({
      d: '2026-08-01',
      a: 10,
      p: 11,
    });
    expect(projectPerformanceRow({ d: '2026-08-01', a: Infinity, p: 11 })).toBeNull();
  });
});
