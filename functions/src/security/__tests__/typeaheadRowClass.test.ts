import { readFileSync } from 'fs';
import { join } from 'path';
import { typeaheadRowClass } from '../../../../src/lib/useTypeaheadNav';

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
