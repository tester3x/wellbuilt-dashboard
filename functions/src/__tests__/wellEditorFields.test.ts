// Default-truth well editor (7/26) — legacy records must never have their
// real values hidden by defaults, and fallback/default engineering must never
// present as persisted. (Lives under functions/__tests__ because this repo's
// jest runner is here; the module under test is the dashboard UI lib —
// routeColor.test.ts precedent.)
//
// Field evidence: Gab 1 persists allowedBottom=1.33 but the editor seeded
// `config.bottomLevel || 3` — the form displayed 3, so pressing Save would
// have overwritten the real 1.33 limit; capacity/height/BBL-per-foot were
// seeded 400/20 and the "Effective BBL/ft" preview + Maintained Wells card
// made those unsaved defaults look stored (40 BBL/ft for a well with no
// persisted engineering at all).
import * as fs from 'fs';
import * as path from 'path';
import {
  WELL_EDITOR_DEFAULTS,
  buildEditorSavePayload,
  effectiveBblPerFoot,
  normalizeWellEditorFields,
} from '../../../src/lib/wellEditorFields';

// ── Sanitized fixtures — the exact production records ──────────────────────
const GAB1_LEGACY = {
  allowedBottom: 1.33,
  loadLine: 1.33,
  numTanks: 2,
  route: 'Test Route',
  routeColor: 'rgb(137, 79, 161)',
  avgFlowRate: '2:09:18',
  avgFlowRateMinutes: 129.31,
  isDown: false,
};

const GABRIEL3_LEGACY = {
  allowedBottom: 3,
  bottomLevel: 3,
  numTanks: 1,
  tanks: 1,
  route: 'Gabriels',
  routeGroupWell: 'Gabriel 3', // self-recording GPS marker — untouched
  ndicApiNo: '33-053-03697-00-00',
  ndicName: 'GABRIEL 3-36-25H',
  pullBbls: 140,
  avgFlowRate: '19:51:40',
  waterWeight: 9.3,
  h2sStatus: 'low',
};

const GABRIEL1_CONFIGURED = {
  bottomLevel: 3,
  allowedBottom: 3,
  tanks: 1,
  numTanks: 1,
  pullBbls: 140,
  tankCapacity: 400,
  tankHeight: 20,
  bblPerFoot: 20,
  routeGroupWell: 'Gabriel 1',
  route: 'Gabriels',
};

describe('normalizeWellEditorFields — presence-aware loading', () => {
  test('1. Gab 1 loads bottom 1.33 via the allowedBottom alias, not default 3', () => {
    const n = normalizeWellEditorFields(GAB1_LEGACY);
    expect(n.bottomFeet.present).toBe(true);
    expect(n.bottomFeet.value).toBe(1.33);
    expect(n.tanks.value).toBe(2);
    expect(n.tanks.present).toBe(true);
  });

  test('2. Gabriel 3 loads bottom 3 (persisted) and its record keeps route Gabriels', () => {
    const n = normalizeWellEditorFields(GABRIEL3_LEGACY);
    expect(n.bottomFeet).toEqual({ value: 3, present: true });
    expect(n.pullBbls).toEqual({ value: 140, present: true });
  });

  test('3. missing engineering fields report present:false (visibly markable)', () => {
    const n = normalizeWellEditorFields(GAB1_LEGACY);
    expect(n.tankCapacity.present).toBe(false);
    expect(n.tankHeight.present).toBe(false);
    expect(n.bblPerFoot.present).toBe(false);
    expect(n.pullBbls.present).toBe(false);
  });

  test('aliases: tankCapacityBbl/tankHeightFt/activeFlowingTanks/nested tankStats resolve', () => {
    const n = normalizeWellEditorFields({
      tankCapacityBbl: 500, tankHeightFt: 25, activeFlowingTanks: 3, numTanks: 4,
    });
    expect(n.tankCapacity).toEqual({ value: 500, present: true });
    expect(n.tankHeight).toEqual({ value: 25, present: true });
    expect(n.activeTanks).toEqual({ value: 3, present: true });
    const nested = normalizeWellEditorFields({ tankStats: { bblPerFoot: 33.3, tankCapacity: 600 } });
    expect(nested.bblPerFoot).toEqual({ value: 33.3, present: true });
    expect(nested.tankCapacity).toEqual({ value: 600, present: true });
  });

  test('8. zero values are honored, never replaced through || behavior', () => {
    const n = normalizeWellEditorFields({ allowedBottom: 0, pullBbls: 0 });
    expect(n.bottomFeet).toEqual({ value: 0, present: true });
    expect(n.pullBbls).toEqual({ value: 0, present: true });
    // The defaults themselves stay what the legacy editor always offered.
    expect(WELL_EDITOR_DEFAULTS).toEqual({
      bottomFeet: 3, tanks: 1, pullBbls: 140, tankCapacity: 400, tankHeight: 20,
    });
  });

  test('numeric strings parse; junk is absent', () => {
    const n = normalizeWellEditorFields({ tankCapacity: '400', tankHeight: 'oops' });
    expect(n.tankCapacity).toEqual({ value: 400, present: true });
    expect(n.tankHeight.present).toBe(false);
  });
});

describe('effectiveBblPerFoot — preview vs saved provenance', () => {
  test('Gab 1: derived from UNSAVED defaults → 40, marked derived-defaults', () => {
    const e = effectiveBblPerFoot(normalizeWellEditorFields(GAB1_LEGACY));
    expect(e.rate).toBe(40); // (400/20)×2 tanks — preview only
    expect(e.source).toBe('derived-defaults');
  });

  test('Gabriel 3: 20 preview from defaults ×1 tank, marked derived-defaults', () => {
    const e = effectiveBblPerFoot(normalizeWellEditorFields(GABRIEL3_LEGACY));
    expect(e.rate).toBe(20);
    expect(e.source).toBe('derived-defaults');
  });

  test('10. fully configured well reports its STORED rate', () => {
    const e = effectiveBblPerFoot(normalizeWellEditorFields(GABRIEL1_CONFIGURED));
    expect(e.rate).toBe(20);
    expect(e.source).toBe('stored');
  });

  test('persisted capacity+height without stored rate → derived-saved', () => {
    const e = effectiveBblPerFoot(normalizeWellEditorFields({ tankCapacity: 740, tankHeight: 22, tanks: 2 }));
    expect(e.rate).toBeCloseTo(67.27, 1);
    expect(e.source).toBe('derived-saved');
  });

  test('override wins and is marked', () => {
    const e = effectiveBblPerFoot(normalizeWellEditorFields({ ...GAB1_LEGACY, bblPerFootOverride: 55 }));
    expect(e).toEqual({ rate: 55, source: 'override' });
  });
});

describe('buildEditorSavePayload — explicit acceptance without clobbering', () => {
  const gab1Save = buildEditorSavePayload({
    route: 'Test Route',
    bottomFeet: 1.33,          // seeded from the alias — the REAL limit
    tanks: 2,
    activeTanks: null,          // blank → defaults to physical tanks
    pullBbls: 140,
    tankCapacity: 400,          // explicit acceptance of displayed defaults
    tankHeight: 20,
    bblPerFootOverride: null,
    equalizedTanks: false,
    requireActualBottom: false,
    h2sStatus: 'unknown',
  });

  test('5/6. Gab 1 save persists engineering AND preserves the real bottom', () => {
    expect(gab1Save.bottomLevel).toBe(1.33);
    expect(gab1Save.allowedBottom).toBe(1.33);
    expect(gab1Save.tankCapacity).toBe(400);
    expect(gab1Save.tankHeight).toBe(20);
    expect(gab1Save.bblPerFoot).toBe(40); // (400/20)×2
    expect(gab1Save.activeTanks).toBe(2);
  });

  test('7. merge payload never carries fields it does not own (loadLine/route markers/AFR survive the merge)', () => {
    // update() merges at the top level — preservation of loadLine,
    // routeGroupWell, routeColor, avgFlowRate* requires they are ABSENT
    // from the payload, not re-written.
    for (const k of ['loadLine', 'routeGroupWell', 'routeColor', 'avgFlowRate', 'avgFlowRateMinutes', 'isDown']) {
      expect(k in gab1Save).toBe(false);
    }
  });

  test('derived rate matches the preview the editor displayed', () => {
    const preview = effectiveBblPerFoot(normalizeWellEditorFields(GAB1_LEGACY));
    expect(gab1Save.bblPerFoot).toBe(preview.rate);
  });

  test('manual override persists as the effective rate', () => {
    const p = buildEditorSavePayload({
      route: 'R', bottomFeet: 3, tanks: 1, activeTanks: null, pullBbls: 140,
      tankCapacity: 400, tankHeight: 20, bblPerFootOverride: 55,
      equalizedTanks: false, requireActualBottom: false, h2sStatus: 'unknown',
    });
    expect(p.bblPerFoot).toBe(55);
    expect(p.bblPerFootOverride).toBe(55);
  });
});

describe('admin page wiring (source-slice proofs)', () => {
  const page = fs.readFileSync(path.join(__dirname, '../../../src/app/admin/page.tsx'), 'utf8');

  test('editor seeds from the presence-aware normalizer, not || defaults', () => {
    expect(page).toContain('normalizeWellEditorFields(');
    expect(page).not.toContain('setEditWellBottom(String(config.bottomLevel || 3))');
    expect(page).not.toContain('setEditWellTankCapacity(String(config.tankCapacity || 400))');
  });

  test('3. unsaved defaults are visibly marked in the edit form', () => {
    expect(page).toContain('Default — not saved');
  });

  test('4. Maintained Wells card marks fallback-derived BBL/ft as a preview', () => {
    expect(page).toContain('BBL/ft (preview)');
    // The old authoritative-looking fallback is gone.
    expect(page).not.toContain("`${(configs[wellName].tanks || configs[wellName].numTanks || 1) * 20} BBL/ft`");
  });

  test('effective-rate label distinguishes saved / preview / override', () => {
    expect(page).toContain('unsaved defaults');
    expect(page).toContain('Manual override');
    expect(page).toContain('Saved:');
  });

  test('5. save goes through the tested payload builder to the EXACT existing key', () => {
    expect(page).toContain('buildEditorSavePayload(');
    expect(page).toContain('well_config/${selectedWell}');
  });

  test('11. no key rewriting — Gab 1 / Gabriel 1 / Gabriel 10 stay separate records', () => {
    // Save targets the selected key verbatim; no normalization/merging of keys.
    expect(page).not.toContain('selectedWell.replace(');
  });
});

// 12. These tests use sanitized fixtures + source text only — no Firebase
// import, no network, no production database access.
describe('isolation', () => {
  test('12. module under test is pure (no firebase import)', () => {
    const lib = fs.readFileSync(path.join(__dirname, '../../../src/lib/wellEditorFields.ts'), 'utf8');
    expect(lib).not.toContain("from './firebase'");
    expect(lib).not.toContain("from '@/lib/firebase'");
    expect(lib).not.toContain("from 'firebase");
  });
});
