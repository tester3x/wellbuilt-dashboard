/**
 * Authoritative deployed-export graph = names exported from
 * functions/src/index.ts, including commented re-export blocks.
 *
 * Client scan covers generic/multiline httpsCallable, callCallable,
 * callUnauthed, authorizedCallable, wrap(), CALLABLE_NAMES maps,
 * REST helpers, and constants such as SSO_ISSUE_CALLABLE.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SKIP_DIR_ALWAYS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.expo',
  'android',
  'ios',
  'coverage',
  '__pycache__',
]);

/** Never skip `lib` — Dashboard/src/lib holds live callable clients. */
const SKIP_DIR_OPTIONAL = new Set(['build', '.next']);

export function stripCommentsPreservingStrings(src: string): string {
  let out = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLine = false;
  let inBlock = false;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 2;
        out += ' ';
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === '/' && next === '/') {
        inLine = true;
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlock = true;
        i += 2;
        continue;
      }
    }
    if (inSingle) {
      out += ch;
      if (ch === '\\' && next) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '\\' && next) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (inTemplate) {
      out += ch;
      if (ch === '\\' && next) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '`') inTemplate = false;
      i += 1;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '`') inTemplate = true;
    out += ch;
    i += 1;
  }
  return out;
}

export function scanDeployedExports(indexSrc: string): string[] {
  const src = stripCommentsPreservingStrings(indexSrc);
  const names = new Set<string>();

  const local = /export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = local.exec(src))) names.add(m[1]);

  const fn = /export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  while ((m = fn.exec(src))) names.add(m[1]);

  const reexport = /export\s*\{([^}]+)\}/g;
  while ((m = reexport.exec(src))) {
    for (const part of m[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const id = trimmed.split(/\s+as\s+/).pop()?.trim();
      if (id && /^[A-Za-z_][A-Za-z0-9_]*$/.test(id) && id !== 'default') {
        names.add(id);
      }
    }
  }

  const star = /export\s+\*\s+from\s+['"][^'"]+['"]/g;
  if (star.test(src)) {
    throw new Error('export_star_not_expanded');
  }

  return [...names].sort();
}

const CALL_PATTERNS: RegExp[] = [
  /httpsCallable\s*(?:<[^>]*>)?\s*\(\s*[^,]+,\s*['"]([A-Za-z0-9_]+)['"]/g,
  /httpsCallable\s*(?:<[^>]*>)?\s*\(\s*[^,]+,\s*\n\s*['"]([A-Za-z0-9_]+)['"]/g,
  /callCallable\s*(?:<[^>]*>)?\s*\(\s*['"]([A-Za-z0-9_]+)['"]/g,
  /callUnauthed\s*(?:<[^>]*>)?\s*\(\s*['"]([A-Za-z0-9_]+)['"]/g,
  /authorizedCallable\s*(?:<[^>]*>)?\s*\(\s*['"]([A-Za-z0-9_]+)['"]/g,
  /\bwrap\s*\(\s*[A-Za-z0-9_]+Handler\s*\)/g,
];

const NAME_MAP_PATTERNS: RegExp[] = [
  /CALLABLE_NAMES\s*=\s*\{([\s\S]*?)\}/,
  /SSO_ISSUE_CALLABLE\s*=\s*['"]([A-Za-z0-9_]+)['"]/,
];

export function scanClientCallableUsage(src: string): string[] {
  const names = new Set<string>();
  const cleaned = stripCommentsPreservingStrings(src);

  for (const re of [
    /httpsCallable\s*(?:<[^>]*>)?\s*\(\s*[\s\S]{0,240}?,\s*['"]([A-Za-z0-9_]+)['"]/g,
    /httpsCallableFromURL[\s\S]{0,200}?['"]https?:\/\/[^'"]+\/([A-Za-z0-9_]+)['"]/g,
    /callCallable\s*(?:<[^>]*>)?\s*\(\s*['"]([A-Za-z0-9_]+)['"]/g,
    /callUnauthed\s*(?:<[^>]*>)?\s*\(\s*['"]([A-Za-z0-9_]+)['"]/g,
    /authorizedCallable\s*(?:<[^>]*>)?\s*\(\s*['"]([A-Za-z0-9_]+)['"]/g,
    /cloudfunctions\.net\/([A-Za-z0-9_]+)/g,
    /functions\.httpsCallable\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g,
  ]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned))) names.add(m[1]);
  }

  const constMaps = [
    /(?:CALLABLE_NAMES|ADMIN_CALLABLE_NAMES)\s*=\s*\{([\s\S]*?)\}/g,
  ];
  for (const re of constMaps) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned))) {
      const body = m[1];
      const kv = /:\s*['"]([A-Za-z0-9_]+)['"]/g;
      let km: RegExpExecArray | null;
      while ((km = kv.exec(body))) names.add(km[1]);
    }
  }

  const sso = /SSO_ISSUE_CALLABLE\s*=\s*['"]([A-Za-z0-9_]+)['"]/g;
  let sm: RegExpExecArray | null;
  while ((sm = sso.exec(cleaned))) names.add(sm[1]);

  return [...names].sort();
}

export function readIndex(abs: string): string {
  return readFileSync(abs, 'utf8');
}

export interface ClientRootSpec {
  id: string;
  path: string;
}

export function walkClientFiles(
  dir: string,
  acc: string[] = [],
  opts?: { allowLib?: boolean },
): string[] {
  if (!existsSync(dir)) return acc;
  let ents: string[] = [];
  try {
    ents = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of ents) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIR_ALWAYS.has(name)) continue;
      if (SKIP_DIR_OPTIONAL.has(name)) continue;
      if (name === 'lib' && opts?.allowLib === false) continue;
      walkClientFiles(p, acc, opts);
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

export function scanClientRoots(roots: ClientRootSpec[]): {
  used: string[];
  scannedRoots: string[];
  skippedMissing: string[];
  fileCountByRoot: Record<string, number>;
} {
  const used = new Set<string>();
  const scannedRoots: string[] = [];
  const skippedMissing: string[] = [];
  const fileCountByRoot: Record<string, number> = {};
  for (const root of roots) {
    if (!existsSync(root.path)) {
      skippedMissing.push(root.id);
      continue;
    }
    const files = walkClientFiles(root.path, [], { allowLib: true });
    fileCountByRoot[root.id] = files.length;
    scannedRoots.push(root.id);
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const name of scanClientCallableUsage(src)) used.add(name);
    }
  }
  return { used: [...used].sort(), scannedRoots, skippedMissing, fileCountByRoot };
}

export const REQUIRED_CLIENT_ROOT_IDS = [
  'dashboard-src',
  'dashboard-src-lib',
  'wb-t',
  'wb-m',
  'suite',
  'jsa',
] as const;

export function resolveRequiredClientRoots(fromDir: string): ClientRootSpec[] {
  let dir = fromDir;
  for (let i = 0; i < 14; i++) {
    const bundleDash = join(dir, 'files', 'Dashboard', 'src');
    const workspaceDash = join(dir, 'Dashboard', 'src');
    if (existsSync(bundleDash)) {
      return [
        { id: 'dashboard-src', path: bundleDash },
        { id: 'dashboard-src-lib', path: join(dir, 'files', 'Dashboard', 'src', 'lib') },
        { id: 'wb-t', path: join(dir, 'files', 'WB-T') },
        { id: 'wb-m', path: join(dir, 'files', 'WB-M', 'src') },
        { id: 'suite', path: join(dir, 'files', 'Suite', 'src') },
        { id: 'jsa', path: join(dir, 'files', 'JSA') },
      ];
    }
    if (existsSync(workspaceDash) && existsSync(join(dir, 'WB-T'))) {
      return [
        { id: 'dashboard-src', path: workspaceDash },
        { id: 'dashboard-src-lib', path: join(dir, 'Dashboard', 'src', 'lib') },
        { id: 'wb-t', path: join(dir, 'WB-T') },
        { id: 'wb-m', path: join(dir, 'WB-M', 'src') },
        { id: 'suite', path: join(dir, 'Suite', 'src') },
        { id: 'jsa', path: join(dir, 'JSA') },
      ];
    }
    dir = join(dir, '..');
  }
  throw new Error('client_roots_unresolved');
}

void CALL_PATTERNS;
void NAME_MAP_PATTERNS;
