import { readFileSync } from 'fs';
import { join } from 'path';
import { optionsShallowEqual, typeaheadRowClass } from '../../../../src/lib/useTypeaheadNav';

const root = join(__dirname, '../../../..');

describe('disposal typeahead selection states', () => {
  it('keyboard, hover, committed, and idle classes are pairwise distinct', () => {
    const keyboard = typeaheadRowClass('keyboard', 'cyan');
    const hover = typeaheadRowClass('hover', 'cyan');
    const committed = typeaheadRowClass('committed', 'cyan');
    const idle = typeaheadRowClass('idle', 'cyan');
    const set = new Set([keyboard, hover, committed, idle]);
    expect(set.size).toBe(4);
    expect(keyboard).toContain('bg-cyan-600/40');
    expect(keyboard).toContain('ring-cyan-400');
    expect(hover).toContain('bg-gray-700');
    expect(committed).toContain('ring-cyan-500');
    expect(idle).toBe('text-white');
  });

  it('keyboard accent is distinct from CSS hover gray (d7730af6)', () => {
    const keyboard = typeaheadRowClass('keyboard', 'cyan');
    expect(keyboard).not.toContain('bg-gray-700');
    expect(typeaheadRowClass('hover', 'cyan')).toContain('bg-gray-700');
  });

  it('Dispatch disposal rows use the restored d7730af6 keyboard fill', () => {
    const page = readFileSync(join(root, 'src/app/dispatch/page.tsx'), 'utf8');
    const hook = readFileSync(join(root, 'src/lib/useTypeaheadNav.ts'), 'utf8');
    const list = readFileSync(join(root, 'src/components/TypeaheadResultList.tsx'), 'utf8');
    expect(hook).toContain('d7730af6f732ad0af4cc2e5c0fc699bde9c6052b');
    expect(list).toContain('d7730af6f732ad0af4cc2e5c0fc699bde9c6052b');
    expect(list).toContain("tabIndex={-1}");
    expect(list).toContain("role=\"option\"");
    expect(page).toContain('TypeaheadResultList');
    expect(page).toContain('useTypeaheadNav');
    expect(page).toContain('pwDisposalNav');
  });
});

describe('typeahead option identity (infinite-rerender and offscreen select)', () => {
  it('does not treat a new array of the same items as a reset (loop-proof)', () => {
    const a = { name: 'WO WATFORD #1' };
    const b = { name: 'WO WATFORD #2' };
    const first = [a, b];
    const second = [a, b];
    expect(first).not.toBe(second);
    expect(optionsShallowEqual(first, second)).toBe(true);
    expect(optionsShallowEqual(first, [a])).toBe(false);
    expect(optionsShallowEqual(first, [a, { name: 'other' }])).toBe(false);
  });

  it('DriverDisposalRow memos one bounded array for both hook and renderer', () => {
    const page = readFileSync(join(root, 'src/app/dispatch/page.tsx'), 'utf8');
    expect(page).toContain('visibleDisposalResults');
    expect(page).toContain('searchDisposals(search, allDisposals, 8)');
    expect(page).toMatch(/useTypeaheadNav\(visibleDisposalResults/);
    expect(page).toMatch(/items=\{visibleDisposalResults\}/);
    expect(page).not.toMatch(/useTypeaheadNav\(results,/);
    expect(page).not.toMatch(/items=\{results\.slice\(0,\s*8\)\}/);
  });

  it('TypeaheadResultList hover does not steal the keyboard index', () => {
    const list = readFileSync(join(root, 'src/components/TypeaheadResultList.tsx'), 'utf8');
    expect(list).not.toMatch(/onMouseEnter/);
    expect(list).not.toMatch(/setActiveIndex/);
    expect(list).toContain('hover:bg-gray-700');
    expect(list).toContain("kind === 'idle' ? 'hover:bg-gray-700'");
  });

  it('every useTypeaheadNav call site consumes a named memoized or state array', () => {
    const page = readFileSync(join(root, 'src/app/dispatch/page.tsx'), 'utf8');
    const calls = [...page.matchAll(/useTypeaheadNav\(([^,]+),/g)].map((m) => m[1].trim());
    expect(calls.length).toBeGreaterThanOrEqual(7);
    for (const arg of calls) {
      expect(arg).not.toMatch(/searchDisposals|\.slice\(|\[\]/);
      expect(['disposalResults', 'swDropoffOptions', 'swWellOptions', 'editPwDisposalResults', 'editSwDisposalResults', 'visibleDisposalResults']).toContain(arg);
    }
  });

  it('hook and TypeaheadResultList option identifiers match at every Dispatch site', () => {
    const page = readFileSync(join(root, 'src/app/dispatch/page.tsx'), 'utf8');
    const constructions = [
      'useTypeaheadNav(disposalResults',
      'useTypeaheadNav(swDropoffOptions',
      'useTypeaheadNav(swWellOptions',
      'useTypeaheadNav(editPwDisposalResults',
      'useTypeaheadNav(editSwDisposalResults',
      'useTypeaheadNav(visibleDisposalResults',
    ];
    for (const ctor of constructions) expect(page).toContain(ctor);
    expect(page).toContain('items={disposalResults}');
    expect(page).toContain('items={swDropoffOptions}');
    expect(page).toContain('items={swWellOptions}');
    expect(page).toContain('items={editPwDisposalResults}');
    expect(page).toContain('items={editSwDisposalResults}');
    expect(page).toContain('items={visibleDisposalResults}');
  });
});
