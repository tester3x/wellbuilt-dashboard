import { positiveNumeric, resolveEditBblPerFoot } from '../editBblPerFoot';

describe('positiveNumeric', () => {
  it('accepts positive numbers and numeric strings; rejects the rest', () => {
    expect(positiveNumeric(40)).toBe(40);
    expect(positiveNumeric(40.5)).toBe(40.5);
    expect(positiveNumeric('40')).toBe(40);
    expect(positiveNumeric(' 40.5 ')).toBe(40.5);
    expect(positiveNumeric(0)).toBeNull();
    expect(positiveNumeric(-1)).toBeNull();
    expect(positiveNumeric('0')).toBeNull();
    expect(positiveNumeric('')).toBeNull();
    expect(positiveNumeric('nope')).toBeNull();
    expect(positiveNumeric(null)).toBeNull();
    expect(positiveNumeric(undefined)).toBeNull();
  });
});

describe('resolveEditBblPerFoot', () => {
  it('uses stored numeric bblPerFoot', () => {
    expect(resolveEditBblPerFoot({ bblPerFoot: 40, tanks: 2 })).toEqual({
      ok: true,
      bblPerFoot: 40,
      source: 'stored',
    });
  });

  it('uses stored numeric-string bblPerFoot', () => {
    expect(resolveEditBblPerFoot({ bblPerFoot: '40.5', tanks: '2' })).toEqual({
      ok: true,
      bblPerFoot: 40.5,
      source: 'stored',
    });
  });

  it('derives (capacity/height)*tanks from numbers', () => {
    // 400 BBL / 20 ft × 2 tanks = 40 total BBL/ft
    expect(resolveEditBblPerFoot({
      tankCapacity: 400,
      tankHeight: 20,
      tanks: 2,
    })).toEqual({ ok: true, bblPerFoot: 40, source: 'derived' });
  });

  it('derives the same from numeric strings (numTanks alias)', () => {
    expect(resolveEditBblPerFoot({
      tankCapacity: '400',
      tankHeight: '20',
      numTanks: '2',
    })).toEqual({ ok: true, bblPerFoot: 40, source: 'derived' });
  });

  it('never falls back to 20×tanks when rate data is missing', () => {
    const missing = resolveEditBblPerFoot({ tanks: 2, numTanks: 2 });
    expect(missing).toEqual({ ok: false, reason: 'bbl_per_foot_unavailable' });
    const onlyTanks = resolveEditBblPerFoot({ tanks: 3 });
    expect(onlyTanks.ok).toBe(false);
    if (onlyTanks.ok) return;
    expect(onlyTanks.reason).toBe('bbl_per_foot_unavailable');
    expect(JSON.stringify(onlyTanks)).not.toMatch(/20/);
  });

  it('fails closed when capacity/height exist but tank count does not', () => {
    expect(resolveEditBblPerFoot({
      tankCapacity: 400,
      tankHeight: 20,
    })).toEqual({ ok: false, reason: 'bbl_per_foot_unavailable' });
  });

  it('ignores non-positive stored rates and does not invent', () => {
    expect(resolveEditBblPerFoot({ bblPerFoot: 0, tanks: 2 })).toEqual({
      ok: false,
      reason: 'bbl_per_foot_unavailable',
    });
  });
});
