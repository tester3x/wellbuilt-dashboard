/**
 * Authoritative HTTPS/export inventory is the functions/src/index.ts
 * module/re-export graph — not a walk of every file (which misses wrap()
 * re-exports and can skip client `lib` trees).
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { scanDeployedExports } from './scanDeployedExports';

export function defaultIndexPath(srcRoot?: string): string {
  if (srcRoot) return join(srcRoot, 'index.ts');
  const here = __dirname;
  if (here.includes(`${join('security')}`)) return join(here, '..', 'index.ts');
  return join(here, 'index.ts');
}

export function scanHttpsExports(srcRoot: string): Array<{ name: string; kind: string; file: string }> {
  const indexPath = existsSync(join(srcRoot, 'index.ts'))
    ? join(srcRoot, 'index.ts')
    : defaultIndexPath(srcRoot);
  const names = scanDeployedExports(readFileSync(indexPath, 'utf8'));
  return names.map((name) => ({ name, kind: 'index_export', file: indexPath }));
}

export function defaultSrcRoot(): string {
  const here = __dirname;
  if (here.includes('security')) return join(here, '..');
  return here;
}
