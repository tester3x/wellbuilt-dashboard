import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addProjectWell, removeProjectWell } from '../projectWellSelection.ts';

test('selection is always an ARRAY and adding preserves order', () => {
  let list: string[] = [];
  list = addProjectWell(list, 'Gabriel 1');
  list = addProjectWell(list, 'Barbarian 1');
  list = addProjectWell(list, 'Thor 1');
  assert.ok(Array.isArray(list));
  assert.deepEqual(list, ['Gabriel 1', 'Barbarian 1', 'Thor 1']);
});

test('adding a duplicate is a no-op (duplicate selection prevented)', () => {
  const list = ['Gabriel 1', 'Thor 1'];
  assert.deepEqual(addProjectWell(list, 'Thor 1'), ['Gabriel 1', 'Thor 1']);
});

test('removing ONE well preserves every other selected well and their order', () => {
  const list = ['Gabriel 1', 'Barbarian 1', 'Thor 1', 'Cyclone 2'];
  assert.deepEqual(removeProjectWell(list, 'Barbarian 1'), ['Gabriel 1', 'Thor 1', 'Cyclone 2']);
  assert.deepEqual(removeProjectWell(list, 'Gabriel 1'), ['Barbarian 1', 'Thor 1', 'Cyclone 2']);
  assert.deepEqual(removeProjectWell(list, 'Cyclone 2'), ['Gabriel 1', 'Barbarian 1', 'Thor 1']);
});

test('removing a non-member leaves the list unchanged; helpers never mutate the input', () => {
  const list = ['Gabriel 1', 'Thor 1'];
  assert.deepEqual(removeProjectWell(list, 'Nope'), ['Gabriel 1', 'Thor 1']);
  addProjectWell(list, 'X');
  removeProjectWell(list, 'Gabriel 1');
  assert.deepEqual(list, ['Gabriel 1', 'Thor 1'], 'original array not mutated');
});

test('remove-then-add round trip keeps the multi-well set intact', () => {
  let list = ['Gabriel 1', 'Barbarian 1', 'Thor 1'];
  list = removeProjectWell(list, 'Barbarian 1');
  list = addProjectWell(list, 'Barbarian 1');
  assert.deepEqual(list.sort(), ['Barbarian 1', 'Gabriel 1', 'Thor 1']);
});
