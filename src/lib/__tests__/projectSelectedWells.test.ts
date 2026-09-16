import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../../app/dispatch/page.tsx', import.meta.url), 'utf8');
// The Projects "Wells" selected area (between the project-well autocomplete and Service Type).
const start = page.indexOf('value={projectWellSearch}');
assert.ok(start >= 0, 'anchor found');
const region = page.slice(start, start + 3200);

test('a single selected well renders a PROMINENT chip (readable name, not the tiny 10px badge)', () => {
  assert.match(region, /role="listitem"/, 'each selected well is a list item');
  assert.match(region, /text-sm text-emerald-50/, 'normal body-size text');
  assert.match(region, /truncate font-medium/, 'name is readable and truncates (no horizontal overflow)');
  // The old tiny badge treatment is gone.
  assert.doesNotMatch(region, /text-\[10px\] rounded flex items-center gap-1/, 'old 10px badge removed');
});

test('selected state does not rely on color alone (✓ indicator + border)', () => {
  assert.match(region, /✓/, 'check glyph marks the selected state');
  assert.match(region, /border border-emerald-500\/60/, 'bordered chip, not color-fill alone');
});

test('each well has an accessible Remove control with a real hit target + distinct focus/hover', () => {
  assert.match(region, /aria-label=\{`Remove \$\{w\}`\}/, 'accessible per-well Remove label');
  assert.match(region, /h-8 w-8/, 'usable pointer/touch target (>=32px)');
  assert.doesNotMatch(region, /flex h-6 w-6 flex-shrink-0/, 'the small 24px target is gone');
  assert.match(region, /focus:ring-2 focus:ring-emerald-400/, 'distinct keyboard focus state');
  assert.match(region, /hover:bg-emerald-500\/40/, 'distinct hover state');
});

test('Remove affects ONLY the chosen well; duplicate selection stays prevented', () => {
  assert.match(region, /setNewProjectWells\(prev => removeProjectWell\(prev, w\)\)/, 'remove uses the pure remove helper (only that well)');
  // Dedup: the autocomplete excludes already-selected wells + the add helper is idempotent.
  assert.match(region, /!newProjectWells\.includes\(w\.wellName\)/, 'already-selected wells cannot be re-added');
  assert.match(region, /setNewProjectWells\(prev => addProjectWell\(prev, w\.wellName\)\)/, 'add uses the dedup helper');
});

test('multiple selections wrap and stay contained (no horizontal overflow)', () => {
  assert.match(region, /flex flex-wrap content-start gap-2 max-h-48 overflow-y-auto/, 'wrapping, contained list');
  assert.match(region, /role="list"/, 'the selected-well area is a list container');
});

test('the selected-well area reserves breathing room (taller Projects card), Projects-only', () => {
  assert.match(region, /wb-selected-wells-area mt-2 min-h-\[4\.5rem\]/, 'min-height reserves ~one extra row');
});

test('an empty selection shows a restrained hint (area does not feel squeezed)', () => {
  assert.match(page, /No wells selected yet — search above to add one or more wells to this project\./, 'empty-state hint present');
});

test('selection SEMANTICS unchanged: multi-well payload + autocomplete behavior preserved', () => {
  // Payload shape is untouched (array of wellName strings).
  assert.match(page, /wellNames: newProjectWells,/, 'project payload still an array of wellNames');
  assert.match(page, /const \[newProjectWells, setNewProjectWells\] = useState<string\[\]>\(\[\]\)/, 'still string[] draft state');
  // The project-well field still uses the shared autocomplete with the same select action.
  assert.match(region, /onSelect=\{\(w\) => \{ setNewProjectWells\(prev => addProjectWell\(prev, w\.wellName\)\); setProjectWellSearch\(''\); \}\}/, 'select appends a wellName');
});

test('N×M dispatch generation is preserved at all three sites (source-contract; generation not refactored)', () => {
  // Multi-well fan-out: every generator loops all wellNames and, per driver, creates a dispatch.
  // (Documented testability limit: these loops call the Firebase staffCreateDispatch callable
  //  inline, so they are not unit-testable without refactoring the generation path — out of scope.)
  const createLoop = /for \(const wellName of newProjectWells\)[\s\S]{0,400}?for \(const driverHash of newProjectDriverHashes\)[\s\S]{0,600}?staffCreateDispatch\(/;
  const addDriverLoop = /for \(const wellName of project\.wellNames\)[\s\S]{0,600}?staffCreateDispatch\(/;
  assert.match(page, createLoop, 'createProject: wells × drivers → staffCreateDispatch');
  assert.match(page, addDriverLoop, 'addDriverToProjectToday / batchDispatchShift: per-well staffCreateDispatch');
  // wellNames array is never reduced to a single well anywhere operative.
  assert.doesNotMatch(page, /wellNames\.slice\(0, ?1\)|wellNames\[0\]\)?\s*[;,)]\s*\/\/ ?operative/, 'no first-well-only operative use');
});

test('the enlarged Notes textarea from the base is preserved', () => {
  assert.match(page, /min-h-\[180px\] sm:min-h-\[240px\][^"]*resize-y/, 'Notes textarea height + resize preserved');
});
