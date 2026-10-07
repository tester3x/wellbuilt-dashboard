import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../../app/dispatch/page.tsx', import.meta.url), 'utf8');
const comp = readFileSync(new URL('../../components/BuilderAutocomplete.tsx', import.meta.url), 'utf8');
const hook = readFileSync(new URL('../useAutocompleteKeyboard.ts', import.meta.url), 'utf8');

test('ALL Job Builder autocomplete fields use the ONE shared BuilderAutocomplete', () => {
  // Eight create-form fields plus edit pickup use the shared component.
  const count = (page.match(/<BuilderAutocomplete/g) || []).length;
  assert.equal(count, 9, 'all eight create fields and edit pickup use the shared component');
  // The aria-labels prove each specific field is covered.
  for (const label of ['Search wells', 'Search SWD disposal', 'Well / location', 'Drop-off (optional)', 'Operator / customer', 'Search wells to add to the project', 'Edit pickup location']) {
    assert.ok(page.includes(`ariaLabel="${label}"`), `field present: ${label}`);
  }
  assert.match(page, /ariaLabel="Drop-off \(optional\)"/);
  assert.match(page, /ariaLabel="Split B destination"/);
  assert.match(page, /ariaLabel=\{`Split \$\{String\.fromCharCode\(67 \+ swExtraSplitLegs\.length\)\} destination`\}/);
  // No bespoke inline suggestion list survives in the Builder create forms.
  assert.ok(!page.includes('No wells found'), 'the old inline PW well list was removed');
});

test('the shared component wires the single keyboard hook (no per-field keyboard logic)', () => {
  assert.match(comp, /useAutocompleteKeyboard\(/);
  assert.match(comp, /\{\.\.\.kb\.inputProps\}/, 'input gets the combobox keyboard props');
  assert.match(comp, /\{\.\.\.kb\.listProps\}/, 'list gets listbox props');
  assert.match(comp, /\{\.\.\.kb\.getOptionProps\(i\)\}/, 'each option gets option props');
});

test('the hook implements the full keyboard contract', () => {
  assert.match(hook, /case 'ArrowDown'/);
  assert.match(hook, /case 'ArrowUp'/);
  assert.match(hook, /case 'Enter'/);
  assert.match(hook, /case 'Escape'/);
  assert.match(hook, /case 'Tab'/);
});

test('scroll is CONTAINER-only (never the page/modal), nearest-edge, offsetParent-independent', () => {
  const scroll = readFileSync(new URL('../scrollActiveOption.ts', import.meta.url), 'utf8');
  // The hook delegates to the shared scroll helper.
  assert.match(hook, /scrollActiveOptionIntoView\(list, optEl\)/, 'hook calls the shared scroll helper');
  // The helper sets the container scrollTop ONLY and uses rect math (not offsetTop),
  // so it works for a non-positioned container (the Projects Well bug).
  assert.match(scroll, /list\.scrollTop = desired/, 'sets the container scrollTop only');
  assert.match(scroll, /getBoundingClientRect\(\)/, 'rect math — independent of offsetParent');
  assert.match(scroll, /optRect\.top - listRect\.top/, 'position derived from rects, not offsetTop');
  // Check the EXECUTABLE code only (comments legitimately mention the old approach).
  const scrollCode = scroll.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(scrollCode, /\.offsetTop/, 'no offsetTop access (that was the Projects Well bug)');
  assert.doesNotMatch(scrollCode, /window\.scroll|scrollIntoView/, 'never scrolls the window/page');
});

test('combobox/listbox ARIA semantics are present', () => {
  assert.match(hook, /role: 'combobox'/);
  assert.match(hook, /'aria-expanded'/);
  assert.match(hook, /'aria-controls'/);
  assert.match(hook, /'aria-activedescendant'/);
  assert.match(hook, /role: 'listbox'/);
  assert.match(hook, /role: 'option'/);
  assert.match(hook, /'aria-selected'/);
});

test('mouse selection is preserved (onMouseDown-preventDefault keeps input focus) + keyboard UX navigation', () => {
  assert.match(hook, /onMouseDown:[\s\S]*?preventDefault\(\)/, 'click will not be lost to blur');
  // Tab from search field enters result 1
  assert.match(hook, /case 'Tab':[\s\S]*?optionRefs\.current\[0\]\?\.focus\(\)/, 'Tab from search field focuses result 1');
  // Option Tab past the last result reaches next field without preventDefault (no trap)
  assert.match(hook, /if \(index < count - 1\) \{[\s\S]*?e\.preventDefault\(\);[\s\S]*?\} else \{[\s\S]*?setActiveIndex\(resetActiveIndex\(\)\);[\s\S]*?\}/, 'Tab after last result does not trap');
  // Shift+Tab from result 1 returns to input
  assert.match(hook, /inputRef\.current\?\.focus\(\)/, 'Shift+Tab returns to search field input');
  // Blur containment is wired in component
  assert.match(comp, /handleBlur/, 'BuilderAutocomplete contains blur within widget');
});

test('hover styling is DISTINCT from keyboard-active styling', () => {
  const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');
  // Hover → its own background token; keyboard-active/focus-visible → active bg + inset ring.
  assert.match(css, /\.wb-option-row:hover\s*\{[^}]*--wb-option-hover-bg/);
  assert.match(css, /\[data-active="true"\][\s\S]{0,120}box-shadow: inset/);
});
