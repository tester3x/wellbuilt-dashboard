const assert = require('node:assert/strict');
const {resolveRequiredTaskAssessment: resolve} = require('../lib/jsaReceipt/jsaRequiredTaskAssessment');
const template = (id, tasks, overrides = {}) => ({
  id, version: 1, contentHash: id.padEnd(64, '0'), name: id, tasks, packageId: null,
  steps: [{id: 'one', title: id, items: [{hazard: 'Fixture hazard', controls: 'Fixture control'}]}],
  ppeItems: [], preparedItems: [], ...overrides,
});
const load = template('a', ['loading']), unload = template('b', ['unloading']);
const catalog = {schemaVersion: 2, templates: [load, unload]};
const both = resolve(catalog, {tasks: ['Unloading', ' Loading ', 'loading'], packageId: null});
assert.equal(both.assessment.steps.length, 2);
assert.deepEqual(both.tasks, ['loading', 'unloading']);
assert.deepEqual(resolve({...catalog, templates: [unload, load]}, {tasks: ['loading', 'unloading'], packageId: null}), both);
const shared = resolve({schemaVersion: 2, templates: [template('c', ['loading', 'unloading'])]}, {tasks: ['loading', 'unloading'], packageId: null});
assert.equal(shared.assessment.steps.length, 1);
assert.equal(shared.templateRefs.length, 1);
assert.notEqual(resolve(catalog, {tasks: ['loading'], packageId: null}).assessmentHash, both.assessmentHash);
assert.notEqual(resolve({...catalog, templates: [{...load, version: 2}, unload]}, {tasks: both.tasks, packageId: null}).assessmentHash, both.assessmentHash);
assert.notEqual(resolve({...catalog, templates: [{...load, contentHash: 'd'.repeat(64)}, unload]}, {tasks: both.tasks, packageId: null}).assessmentHash, both.assessmentHash);
const fallback = template('e', []);
assert.equal(resolve({...catalog, templates: [...catalog.templates, fallback]}, {tasks: ['loading'], packageId: null}).templateRefs[0].id, 'a');
assert.equal(resolve({...catalog, templates: [...catalog.templates, fallback]}, {tasks: ['service'], packageId: null}).templateRefs[0].id, 'e');
assert.throws(() => resolve(catalog, {tasks: ['load'], packageId: null}), /unavailable/);
assert.throws(() => resolve(catalog, {tasks: [], packageId: null}), /unavailable/);
assert.throws(() => resolve({...catalog, templates: [load, {...load, id: 'f'}]}, {tasks: ['loading'], packageId: null}), /Ambiguous/);
assert.throws(() => resolve({...catalog, templates: [fallback, template('f', [])]}, {tasks: ['service'], packageId: null}), /Ambiguous/);
assert.throws(() => resolve(catalog, {tasks: ['loading'], packageId: 'other-operator'}), /unavailable/);
assert.throws(() => resolve(catalog, {tasks: ['loading'], packageId: '../other'}), /Invalid/);
assert.throws(() => resolve({schemaVersion: 1, templates: []}, {tasks: ['loading'], packageId: null}), /catalog/);
const packaged = resolve({...catalog, templates: [{...load, packageId: 'operator-a'}, {...unload, packageId: 'operator-a'}, load]}, {tasks: both.tasks, packageId: 'operator-a'});
assert.equal(packaged.packageId, 'operator-a');
assert.equal(packaged.templateRefs.length, 2);
assert.notEqual(packaged.assessmentHash, both.assessmentHash);
console.log('PASS: required task matching, shared-template deduplication, package isolation, deterministic version/content binding, fallback and ambiguity rejection (fixtures only)');
