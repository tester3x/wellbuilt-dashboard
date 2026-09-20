import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const FUNCTIONS_SRC = join(__dirname, '..', '..', '..');
const FUNCTIONS_ROOT = join(FUNCTIONS_SRC, '..');

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(ts|js)$/.test(entry.name) && !entry.name.includes('.test.')) acc.push(full);
  }
  return acc;
}

describe('dispatch writer census after C3 audit repair', () => {
  const files = [
    ...walk(FUNCTIONS_SRC),
    ...walk(join(FUNCTIONS_ROOT, 'scripts')).filter(() => existsSync(join(FUNCTIONS_ROOT, 'scripts'))),
  ];

  it('no dispatch .add() or auto-id .doc() birth remains', () => {
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (/collection\(['"]dispatches['"]\)\s*\.add\s*\(/.test(text)) hits.push(`${file}:add`);
      if (/collection\(['"]dispatches['"]\)\s*\.doc\s*\(\s*\)/.test(text)) hits.push(`${file}:auto-id`);
    }
    expect(hits).toEqual([]);
  });

  it('staffWriteDispatch create uses transactional create-if-absent with four-field pin', () => {
    const src = readFileSync(join(FUNCTIONS_SRC, 'security', 'staffWriteDispatchCallable.ts'), 'utf8');
    expect(src).toMatch(/stampDispatchBinding/);
    expect(src).toMatch(/evaluateCreateIfAbsent/);
    expect(src).toMatch(/tx\.create/);
    expect(src).not.toMatch(/\.add\(/);
  });

  it('createDriverDispatchIfAbsent creates only through governed pin birth', () => {
    const src = readFileSync(join(FUNCTIONS_SRC, 'security', 'createDriverDispatchCallable.ts'), 'utf8');
    expect(src).toMatch(/evaluateDriverDispatchBirth/);
    expect(src).toMatch(/loadVerifiedRevision/);
    expect(src).toMatch(/tx\.create/);
    expect(src).not.toMatch(/\.add\(/);
  });

  it('acceptDriverDispatch is update-only after revision reload', () => {
    const src = readFileSync(join(FUNCTIONS_SRC, 'security', 'acceptDriverDispatchCallable.ts'), 'utf8');
    expect(src).toMatch(/runAcceptDriverDispatch/);
    expect(src).toMatch(/tx\.update/);
    expect(src).not.toMatch(/tx\.create/);
    expect(src).not.toMatch(/\.add\(/);
  });

  it('upsertDriverDispatch remains update-only', () => {
    const src = readFileSync(join(FUNCTIONS_SRC, 'security', 'operational', 'invoiceOps.ts'), 'utf8');
    expect(src).toMatch(/mode: 'update_only'/);
    expect(src).toMatch(/evaluateExistingDispatchDriverUpdate/);
    expect(src).toMatch(/ref\.update\(patch\)/);
    expect(src).not.toMatch(/set\(d, \{ merge: true \}\)/);
    expect(src).not.toMatch(/collection\('dispatches'\)\.add/);
  });

  it('addSplitLeg creates only through governed pin birth', () => {
    const src = readFileSync(join(FUNCTIONS_SRC, 'security', 'addSplitLegCallable.ts'), 'utf8');
    expect(src).toMatch(/runAddSplitLeg/);
    expect(src).toMatch(/tx\.create/);
    expect(src).toMatch(/requireSecureDriver/);
    expect(src).not.toMatch(/\.add\(/);
    expect(src).not.toMatch(/merge:\s*true/);
  });

  it('dismissDispatch updates only', () => {
    const src = readFileSync(join(FUNCTIONS_SRC, 'security', 'dismissDispatchCallable.ts'), 'utf8');
    expect(src).toMatch(/tx\.update/);
    expect(src).not.toMatch(/tx\.create/);
    expect(src).not.toMatch(/collection\('dispatches'\)\.add/);
  });

  it('invoice and index dispatch writers do not create dispatches', () => {
    const index = readFileSync(join(FUNCTIONS_SRC, 'index.ts'), 'utf8');
    expect(index).toMatch(/collection\('dispatches'\)\.doc\(ctxDispatchId\)\.update/);
    expect(index).not.toMatch(/collection\(['"]dispatches['"]\)\.add/);
    expect(index).not.toMatch(/collection\(['"]dispatches['"]\)\.doc\(\)/);
    const check = readFileSync(join(FUNCTIONS_SRC, 'check-15414.ts'), 'utf8');
    expect(check).toMatch(/collection\('dispatches'\)/);
    expect(check).not.toMatch(/collection\(['"]dispatches['"]\)\.add/);
    expect(check).not.toMatch(/collection\(['"]dispatches['"]\)\.doc\([^)]*\)\.set\(/);
    const fix = readFileSync(join(FUNCTIONS_SRC, 'fix-st-invoices.ts'), 'utf8');
    expect(fix).toMatch(/collection\('dispatches'\)\.doc/);
    expect(fix).not.toMatch(/collection\(['"]dispatches['"]\)\.add/);
  });
});
