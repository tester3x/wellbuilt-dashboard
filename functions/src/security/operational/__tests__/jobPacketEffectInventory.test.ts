import * as fs from 'fs';
import * as path from 'path';
import { SERVER_IMPLEMENTED_EFFECTS } from '../jobPacketRevisionStore';
import * as inventory from '../jobPacketEffectInventory';
import {
  CAPABILITY_TRUTH,
  CAPABILITY_TRUTH_KEYS,
  CAPABILITY_TRUTH_KINDS,
  IMPLEMENTED_EFFECT_IDS,
  INVENTORY_SCHEMA_VERSION,
  POLICY_INVENTORY,
  POLICY_RECORD_KEYS,
  serializeJobPacketInventory,
} from '../jobPacketEffectInventory';

const FUNCTIONS_ROOT = path.join(__dirname, '..', '..', '..', '..');
const INVENTORY_FILE = path.normalize(path.join(__dirname, '..', 'jobPacketEffectInventory.ts'));
const TEST_FILE = path.normalize(__filename);

const CONTRACTS_CAPABILITY_IDS = [
  'lifecycle', 'onSite', 'pickup', 'dropoff', 'multiHaul',
  'splitTicket', 'transfer', 'photos', 'signatures',
] as const;

const CLIENT_ONLY_OPS = [
  'addSplitLeg',
  'acceptDriverDispatch',
  'createDriverDispatchIfAbsent',
  'upsertDriverDispatch',
  'invoiceCreate',
  'invoiceClose',
  'dispatchAccept',
  'dispatchComplete',
  'dispatchCreate',
  'splitTickets',
  'splitHaul',
  'splitTicket',
  'multiHaul',
] as const;

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

function compiledExportNames(filePath: string): string[] {
  const src = fs.readFileSync(filePath, 'utf8');
  const names = new Set<string>();
  for (const match of src.matchAll(/exports\.([A-Za-z0-9_]+)\s*=/g)) names.add(match[1]);
  for (const match of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name.replace(/[^\w]/g, ''));
    }
  }
  return [...names];
}

describe('schema version', () => {
  it('is a stable finite integer', () => {
    expect(INVENTORY_SCHEMA_VERSION).toBe(1);
    expect(Number.isFinite(INVENTORY_SCHEMA_VERSION)).toBe(true);
    expect(Number.isInteger(INVENTORY_SCHEMA_VERSION)).toBe(true);
  });
});

describe('deep freeze and mutation resistance', () => {
  it('freezes inventory exports', () => {
    expect(Object.isFrozen(IMPLEMENTED_EFFECT_IDS)).toBe(true);
    expect(Object.isFrozen(POLICY_INVENTORY)).toBe(true);
    expect(Object.isFrozen(CAPABILITY_TRUTH)).toBe(true);
    expect(Object.isFrozen(POLICY_RECORD_KEYS)).toBe(true);
    expect(Object.isFrozen(CAPABILITY_TRUTH_KEYS)).toBe(true);
    expect(Object.isFrozen(CAPABILITY_TRUTH_KINDS)).toBe(true);
    for (const row of CAPABILITY_TRUTH) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.missingSurfaces)).toBe(true);
    }
  });

  it('rejects mutation, addition, deletion, and reassignment of inventory data', () => {
    const before = serializeJobPacketInventory();
    expect(() => { (IMPLEMENTED_EFFECT_IDS as unknown as string[]).push('lifecycle'); }).toThrow();
    expect(() => { (IMPLEMENTED_EFFECT_IDS as unknown as string[]).splice(0, 0, 'pickup'); }).toThrow();
    expect(() => { (POLICY_INVENTORY as unknown as object[]).push({}); }).toThrow();
    expect(() => { (CAPABILITY_TRUTH as unknown as object[]).pop(); }).toThrow();
    expect(() => { (CAPABILITY_TRUTH[0] as { implementedAsServerEffect: boolean }).implementedAsServerEffect = true; }).toThrow();
    expect(() => { (CAPABILITY_TRUTH[0].missingSurfaces as unknown as string[]).push('extra'); }).toThrow();
    expect(() => { (IMPLEMENTED_EFFECT_IDS as unknown as string[])[0] = 'lifecycle'; }).toThrow();
    expect(serializeJobPacketInventory()).toBe(before);
    expect([...IMPLEMENTED_EFFECT_IDS]).toEqual([]);
    expect(POLICY_INVENTORY.length).toBe(0);
    expect(CAPABILITY_TRUTH[0].implementedAsServerEffect).toBe(false);
    void inventory;
  });
});

describe('record keys, uniqueness, and order', () => {
  it('keeps policy IDs unique and records on the allowed key set', () => {
    const ids = POLICY_INVENTORY.map((row) => row.policyId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of POLICY_INVENTORY) {
      expect(Object.getOwnPropertyNames(row).sort()).toEqual([...POLICY_RECORD_KEYS].slice().sort());
      expect(row.producesImplementedEffect).toBe(false);
      expect(row.safeForPacketPolicyRefs).toBe(false);
    }
  });

  it('keeps capability-truth IDs unique with only allowed keys', () => {
    const ids = CAPABILITY_TRUTH.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of CAPABILITY_TRUTH) {
      expect(Object.getOwnPropertyNames(row).sort()).toEqual([...CAPABILITY_TRUTH_KEYS].slice().sort());
      expect((CAPABILITY_TRUTH_KINDS as readonly string[]).includes(row.kind)).toBe(true);
      expect(row.implementedAsServerEffect).toBe(false);
      expect(row.producesImplementedEffect).toBe(false);
    }
  });

  it('is deterministic in declared order', () => {
    expect(CAPABILITY_TRUTH.map((row) => row.id)).toEqual(CAPABILITY_TRUTH.map((row) => row.id));
    expect(serializeJobPacketInventory()).toBe(serializeJobPacketInventory());
  });
});

describe('IMPLEMENTED_EFFECT_IDS is exactly empty', () => {
  it('is an empty frozen list and stays empty after mutation attempts', () => {
    expect(IMPLEMENTED_EFFECT_IDS).toEqual([]);
    expect(IMPLEMENTED_EFFECT_IDS.length).toBe(0);
    expect(Array.isArray(IMPLEMENTED_EFFECT_IDS)).toBe(true);
    expect(() => { (IMPLEMENTED_EFFECT_IDS as unknown as string[]).splice(0, 0, 'pickup'); }).toThrow();
    expect([...IMPLEMENTED_EFFECT_IDS]).toEqual([]);
    expect([...SERVER_IMPLEMENTED_EFFECTS]).toEqual([]);
  });

  it('contains no contracts capability IDs', () => {
    for (const id of CONTRACTS_CAPABILITY_IDS) {
      expect(IMPLEMENTED_EFFECT_IDS as readonly string[]).not.toContain(id);
    }
  });

  it('contains no client-only split, multi-haul, acceptance, completion, or ticket operations', () => {
    for (const id of CLIENT_ONLY_OPS) {
      expect(IMPLEMENTED_EFFECT_IDS as readonly string[]).not.toContain(id);
    }
  });

  it('does not treat any classified capability as an implemented effect', () => {
    for (const row of CAPABILITY_TRUTH) {
      expect(row.implementedAsServerEffect).toBe(false);
      expect(IMPLEMENTED_EFFECT_IDS as readonly string[]).not.toContain(row.id);
    }
  });
});

describe('serialization and plain-data invariants', () => {
  it('serializes deterministically to JSON without functions or holes', () => {
    const json = serializeJobPacketInventory();
    const again = serializeJobPacketInventory();
    expect(json).toBe(again);
    const parsed = JSON.parse(json) as {
      schemaVersion: number;
      policies: unknown[];
      implementedEffectIds: unknown[];
      capabilityTruth: unknown[];
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.implementedEffectIds).toEqual([]);
    expect(parsed.policies).toEqual([]);
    expect(parsed.capabilityTruth).toHaveLength(CAPABILITY_TRUTH.length);
    expect(json).not.toMatch(/undefined/);
  });

  it('has no function, symbol, or inherited values on live records', () => {
    for (const row of CAPABILITY_TRUTH) {
      expect(Object.getPrototypeOf(row) === Object.prototype || Object.getPrototypeOf(row) === null).toBe(true);
      expect(Object.getOwnPropertySymbols(row).length).toBe(0);
      for (const key of Object.getOwnPropertyNames(row)) {
        const desc = Object.getOwnPropertyDescriptor(row, key);
        expect(desc && desc.get === undefined && desc.set === undefined).toBe(true);
        expect(typeof (row as Record<string, unknown>)[key] !== 'function').toBe(true);
        expect((row as Record<string, unknown>)[key] !== undefined).toBe(true);
      }
      for (let i = 0; i < row.missingSurfaces.length; i++) {
        expect(Object.prototype.hasOwnProperty.call(row.missingSurfaces, i)).toBe(true);
        expect(Number.isFinite(i)).toBe(true);
      }
    }
    expect(Number.isFinite(INVENTORY_SCHEMA_VERSION)).toBe(true);
  });
});

describe('compiled output and dormancy', () => {
  const srcIndex = path.join(FUNCTIONS_ROOT, 'src', 'index.ts');
  const securityIndex = path.join(FUNCTIONS_ROOT, 'src', 'security', 'index.ts');
  const operationalIndex = path.join(FUNCTIONS_ROOT, 'src', 'security', 'operational', 'index.ts');
  const libIndex = path.join(FUNCTIONS_ROOT, 'lib', 'index.js');
  const libInventory = path.join(FUNCTIONS_ROOT, 'lib', 'security', 'operational', 'jobPacketEffectInventory.js');

  it('preserves the empty frozen effect inventory in compiled output', () => {
    expect(fs.existsSync(libInventory)).toBe(true);
    const compiled = require(libInventory) as { IMPLEMENTED_EFFECT_IDS: readonly unknown[] };
    expect([...compiled.IMPLEMENTED_EFFECT_IDS]).toEqual([]);
    expect(Object.isFrozen(compiled.IMPLEMENTED_EFFECT_IDS)).toBe(true);
    expect(() => { (compiled.IMPLEMENTED_EFFECT_IDS as unknown as string[]).push('lifecycle'); }).toThrow();
  });

  it('does not expose a new deployable function on root source or compiled exports', () => {
    const src = fs.readFileSync(srcIndex, 'utf8');
    const security = fs.readFileSync(securityIndex, 'utf8');
    const operational = fs.readFileSync(operationalIndex, 'utf8');
    expect(src).not.toMatch(/jobPacketEffectInventory/);
    expect(security).not.toMatch(/jobPacketEffectInventory/);
    expect(operational).not.toMatch(/jobPacketEffectInventory/);
    expect(compiledExportNames(srcIndex)).not.toContain('serializeJobPacketInventory');
    expect(compiledExportNames(securityIndex)).not.toContain('serializeJobPacketInventory');
    const libJs = fs.readFileSync(libIndex, 'utf8');
    expect(libJs).not.toMatch(/jobPacketEffectInventory/);
    expect(libJs).not.toMatch(/serializeJobPacketInventory/);
    expect(compiledExportNames(libIndex)).not.toContain('serializeJobPacketInventory');
  });

  it('is not imported by any other runtime source', () => {
    const hits: string[] = [];
    for (const file of walkFiles(path.join(FUNCTIONS_ROOT, 'src'))) {
      const norm = path.normalize(file);
      if (norm === INVENTORY_FILE || norm === TEST_FILE) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('jobPacketEffectInventory')) hits.push(path.relative(FUNCTIONS_ROOT, file));
    }
    expect(hits).toEqual([]);
  });

  it('registers no callable, HTTP handler, trigger, or schedule', () => {
    const src = fs.readFileSync(INVENTORY_FILE, 'utf8');
    expect(src).not.toMatch(/httpsV2/);
    expect(src).not.toMatch(/onCall/);
    expect(src).not.toMatch(/onRequest/);
    expect(src).not.toMatch(/onSchedule/);
    expect(src).not.toMatch(/functionsV1/);
    expect(src).not.toMatch(/firebase-admin/);
    expect(src).not.toMatch(/manageDrivers/);
    expect(src).not.toMatch(/targetCompanyId/);
  });
});
