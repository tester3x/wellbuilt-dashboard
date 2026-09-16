/**
 * Comprehensive tests for Dispatch Job Types vocabulary configuration core.
 *
 * Tests the pure core functions:
 * - In-memory defaults fallback without writing
 * - Add, rename, enable/disable, and reorder operations
 * - Immutability of stable IDs across code and label updates
 * - Code validation: exactly 2 uppercase letters, duplicate rejection (case-insensitive)
 * - Label validation: non-blank, duplicate rejection (case-insensitive)
 * - Enabled state enforcement: 1 enabled allowed, 0 enabled blocked
 * - Single-class configurations allowed (all PW or all SW)
 * - Malformed / legacy stored configuration fails safely to defaults
 * - Deterministic ordering and payload construction
 *
 * Run: node --test --experimental-strip-types src/lib/__tests__/dispatchJobTypesCore.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DISPATCH_JOB_TYPES,
  getDefaultDispatchJobTypes,
  resolveDispatchJobTypes,
  parseDispatchJobTypesConfig,
  validateDispatchJobTypes,
  moveJobTypeUp,
  moveJobTypeDown,
  buildDispatchJobTypesPayload,
  generateJobTypeId,
  normalizeJobTypeCode,
  normalizeJobTypeName,
  type DispatchJobTypeEntry,
  type DispatchJobTypeConfig,
} from '../dispatchJobTypesCore.ts';

test('1. Missing configuration fails safely to in-memory PW/SW defaults without writing', () => {
  const fromUndefined = resolveDispatchJobTypes(undefined);
  assert.equal(fromUndefined.length, 2);
  assert.deepEqual(fromUndefined[0], {
    id: 'pw-default',
    code: 'PW',
    name: 'Production Water',
    workClass: 'pw',
    enabled: true,
    order: 0,
  });
  assert.deepEqual(fromUndefined[1], {
    id: 'sw-default',
    code: 'SW',
    name: 'Service Work',
    workClass: 'sw',
    enabled: true,
    order: 1,
  });

  const fromNull = resolveDispatchJobTypes(null);
  assert.equal(fromNull.length, 2);
  assert.equal(fromNull[0].code, 'PW');
  assert.equal(fromNull[1].code, 'SW');

  const fromEmptyObj = resolveDispatchJobTypes({});
  assert.equal(fromEmptyObj.length, 2);

  // Verifying mutating returned array doesn't corrupt DEFAULT_DISPATCH_JOB_TYPES
  const defaults = getDefaultDispatchJobTypes();
  defaults[0].code = 'XX';
  assert.equal(DEFAULT_DISPATCH_JOB_TYPES[0].code, 'PW');
});

test('2. Malformed stored configurations fail safely to in-memory defaults', () => {
  // Corrupt string / numbers
  assert.equal(resolveDispatchJobTypes('invalid json string').length, 2);
  assert.equal(resolveDispatchJobTypes(12345).length, 2);
  assert.equal(resolveDispatchJobTypes(true).length, 2);

  // Empty items array
  assert.equal(resolveDispatchJobTypes({ version: 1, items: [] }).length, 2);

  // Non-array items
  assert.equal(resolveDispatchJobTypes({ version: 1, items: 'not an array' }).length, 2);

  // Corrupt items within array: items missing code and name are dropped; if all dropped, fallback to default
  assert.equal(resolveDispatchJobTypes({ version: 1, items: [null, {}, undefined] }).length, 2);

  // Partial corrupt item: item with code or name is recovered safely
  const recovered = resolveDispatchJobTypes({
    version: 1,
    items: [
      { code: 'dw', name: 'Disposal Water', workClass: 'pw', enabled: true },
      null,
      { code: 'fw', name: 'Fresh Water', workClass: 'sw', enabled: false },
    ],
  });
  assert.equal(recovered.length, 2);
  assert.equal(recovered[0].code, 'DW');
  assert.equal(recovered[0].workClass, 'pw');
  assert.equal(recovered[0].order, 0);
  assert.equal(recovered[1].code, 'FW');
  assert.equal(recovered[1].workClass, 'sw');
  assert.equal(recovered[1].enabled, false);
  assert.equal(recovered[1].order, 1);
  assert.ok(recovered[0].id.length > 0);
  assert.ok(recovered[1].id.length > 0);
});

test('3. Add, rename, enable/disable, and stable ID preservation', () => {
  const initial = getDefaultDispatchJobTypes();
  const initialPwId = initial[0].id;
  const initialSwId = initial[1].id;

  // Add custom DW entry
  const newId = generateJobTypeId();
  const modified: DispatchJobTypeEntry[] = [
    ...initial,
    {
      id: newId,
      code: 'DW',
      name: 'Disposal Water',
      workClass: 'pw',
      enabled: true,
      order: 2,
    },
  ];

  // Rename PW -> "Prod Water" and change code -> "PR"
  modified[0] = {
    ...modified[0],
    code: 'PR',
    name: 'Prod Water',
  };

  // Disable SW
  modified[1] = {
    ...modified[1],
    enabled: false,
  };

  // Assert stable IDs survived renaming and updates
  assert.equal(modified[0].id, initialPwId, 'Stable ID must never change on rename or code update');
  assert.equal(modified[1].id, initialSwId, 'Stable ID must never change on enable/disable');
  assert.equal(modified[2].id, newId);

  // Validate that modified list is completely valid
  const validation = validateDispatchJobTypes(modified);
  assert.equal(validation.valid, true);
});

test('4. Code validation: exactly 2 uppercase letters; duplicate/invalid codes blocked', () => {
  // Test code normalization
  assert.equal(normalizeJobTypeCode(' pw '), 'PW');
  assert.equal(normalizeJobTypeCode('sw'), 'SW');

  // Single letter code -> rejected
  const singleLetter: DispatchJobTypeEntry[] = [
    { id: '1', code: 'P', name: 'Production Water', workClass: 'pw', enabled: true, order: 0 },
  ];
  const valSingle = validateDispatchJobTypes(singleLetter);
  assert.equal(valSingle.valid, false);
  assert.match(valSingle.rowErrors['1']?.code || '', /exactly 2 letters/);

  // 3-letter code -> rejected
  const threeLetters: DispatchJobTypeEntry[] = [
    { id: '1', code: 'PRO', name: 'Production Water', workClass: 'pw', enabled: true, order: 0 },
  ];
  const valThree = validateDispatchJobTypes(threeLetters);
  assert.equal(valThree.valid, false);
  assert.match(valThree.rowErrors['1']?.code || '', /exactly 2 letters/);

  // Numbers or symbols -> rejected
  const numericCode: DispatchJobTypeEntry[] = [
    { id: '1', code: 'P1', name: 'Production Water', workClass: 'pw', enabled: true, order: 0 },
  ];
  assert.equal(validateDispatchJobTypes(numericCode).valid, false);

  // Blank code -> rejected
  const emptyCode: DispatchJobTypeEntry[] = [
    { id: '1', code: '', name: 'Production Water', workClass: 'pw', enabled: true, order: 0 },
  ];
  assert.equal(validateDispatchJobTypes(emptyCode).valid, false);

  // Duplicate codes (case-insensitive) -> rejected
  const duplicateCodes: DispatchJobTypeEntry[] = [
    { id: '1', code: 'PW', name: 'Production Water', workClass: 'pw', enabled: true, order: 0 },
    { id: '2', code: 'pw', name: 'Pure Water', workClass: 'pw', enabled: true, order: 1 },
  ];
  const valDup = validateDispatchJobTypes(duplicateCodes);
  assert.equal(valDup.valid, false);
  assert.match(valDup.rowErrors['1']?.code || '', /Duplicate code/);
  assert.match(valDup.rowErrors['2']?.code || '', /Duplicate code/);
});

test('5. Display name validation: non-blank and unambiguous (unique)', () => {
  // Empty display name -> rejected
  const emptyName: DispatchJobTypeEntry[] = [
    { id: '1', code: 'PW', name: '   ', workClass: 'pw', enabled: true, order: 0 },
  ];
  const valEmpty = validateDispatchJobTypes(emptyName);
  assert.equal(valEmpty.valid, false);
  assert.match(valEmpty.rowErrors['1']?.name || '', /Display name is required/);

  // Duplicate display names (case-insensitive) -> rejected
  const duplicateNames: DispatchJobTypeEntry[] = [
    { id: '1', code: 'PW', name: 'Production Water', workClass: 'pw', enabled: true, order: 0 },
    { id: '2', code: 'SW', name: 'production water', workClass: 'sw', enabled: true, order: 1 },
  ];
  const valDup = validateDispatchJobTypes(duplicateNames);
  assert.equal(valDup.valid, false);
  assert.match(valDup.rowErrors['1']?.name || '', /Duplicate name/);
  assert.match(valDup.rowErrors['2']?.name || '', /Duplicate name/);
});

test('6. Enabled state enforcement: 1 enabled allowed; 0 enabled blocked', () => {
  // 1 enabled entry -> valid
  const oneEnabled: DispatchJobTypeEntry[] = [
    { id: '1', code: 'PW', name: 'Production Water', workClass: 'pw', enabled: true, order: 0 },
    { id: '2', code: 'SW', name: 'Service Work', workClass: 'sw', enabled: false, order: 1 },
  ];
  assert.equal(validateDispatchJobTypes(oneEnabled).valid, true);

  // 0 enabled entries -> blocked
  const zeroEnabled: DispatchJobTypeEntry[] = [
    { id: '1', code: 'PW', name: 'Production Water', workClass: 'pw', enabled: false, order: 0 },
    { id: '2', code: 'SW', name: 'Service Work', workClass: 'sw', enabled: false, order: 1 },
  ];
  const valZero = validateDispatchJobTypes(zeroEnabled);
  assert.equal(valZero.valid, false);
  assert.match(valZero.generalError || '', /At least one job type must remain enabled/);
});

test('7. WorkClass flexibility: does not require both PW and SW', () => {
  // Only PW-side choices
  const onlyPw: DispatchJobTypeEntry[] = [
    { id: '1', code: 'PW', name: 'Production Water', workClass: 'pw', enabled: true, order: 0 },
    { id: '2', code: 'DW', name: 'Disposal Water', workClass: 'pw', enabled: true, order: 1 },
    { id: '3', code: 'FW', name: 'Flowback Water', workClass: 'pw', enabled: true, order: 2 },
  ];
  assert.equal(validateDispatchJobTypes(onlyPw).valid, true);

  // Only SW-side choices
  const onlySw: DispatchJobTypeEntry[] = [
    { id: '1', code: 'SW', name: 'General Service', workClass: 'sw', enabled: true, order: 0 },
    { id: '2', code: 'VW', name: 'Vac Work', workClass: 'sw', enabled: true, order: 1 },
  ];
  assert.equal(validateDispatchJobTypes(onlySw).valid, true);
});

test('8. Move Up and Move Down reordering is deterministic and bounded', () => {
  const items: DispatchJobTypeEntry[] = [
    { id: '1', code: 'PW', name: 'Production Water', workClass: 'pw', enabled: true, order: 0 },
    { id: '2', code: 'SW', name: 'Service Work', workClass: 'sw', enabled: true, order: 1 },
    { id: '3', code: 'DW', name: 'Disposal Water', workClass: 'pw', enabled: true, order: 2 },
  ];

  // Moving top item up does nothing
  assert.deepEqual(moveJobTypeUp(items, 0), items);

  // Moving item 1 (SW) up swaps with item 0 (PW)
  const movedUp = moveJobTypeUp(items, 1);
  assert.equal(movedUp[0].code, 'SW');
  assert.equal(movedUp[0].order, 0);
  assert.equal(movedUp[1].code, 'PW');
  assert.equal(movedUp[1].order, 1);
  assert.equal(movedUp[2].code, 'DW');
  assert.equal(movedUp[2].order, 2);

  // Moving bottom item down does nothing
  assert.deepEqual(moveJobTypeDown(items, 2), items);

  // Moving item 0 (PW) down swaps with item 1 (SW)
  const movedDown = moveJobTypeDown(items, 0);
  assert.equal(movedDown[0].code, 'SW');
  assert.equal(movedDown[0].order, 0);
  assert.equal(movedDown[1].code, 'PW');
  assert.equal(movedDown[1].order, 1);
  assert.equal(movedDown[2].code, 'DW');
  assert.equal(movedDown[2].order, 2);
});

test('9. buildDispatchJobTypesPayload normalizes entries, sets version: 1, and stamps metadata', () => {
  const rawEntries: DispatchJobTypeEntry[] = [
    { id: 'pw-1', code: ' pw ', name: ' Production Water  ', workClass: 'pw', enabled: true, order: 99 },
    { id: 'sw-1', code: 'sw', name: 'Service Work', workClass: 'sw', enabled: false, order: 5 },
  ];

  const payload = buildDispatchJobTypesPayload(rawEntries, 'user-admin-123');

  assert.equal(payload.version, 1);
  assert.equal(payload.updatedByUid, 'user-admin-123');
  assert.ok(payload.updatedAtIso);
  assert.equal(payload.items.length, 2);

  // Check normalization
  assert.equal(payload.items[0].code, 'PW');
  assert.equal(payload.items[0].name, 'Production Water');
  assert.equal(payload.items[0].order, 0);
  assert.equal(payload.items[0].enabled, true);

  assert.equal(payload.items[1].code, 'SW');
  assert.equal(payload.items[1].name, 'Service Work');
  assert.equal(payload.items[1].order, 1);
  assert.equal(payload.items[1].enabled, false);
});
