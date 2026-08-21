#!/usr/bin/env node
/** Fail if default rule files still grant public root access. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rtdb = readFileSync(join(root, 'database.rules.json'), 'utf8');
const fs = readFileSync(join(root, 'firestore.rules'), 'utf8');
const st = readFileSync(join(root, 'storage.rules'), 'utf8');

let failed = false;
if (/"\.read"\s*:\s*true/.test(rtdb) && /"rules"\s*:\s*\{[^}]*"\.read"\s*:\s*true/.test(rtdb.replace(/\s+/g, ''))) {
  // root-level true is the incident
}
const rtdbCompact = rtdb.replace(/\s+/g, '');
if (rtdbCompact.includes('"rules":{".read":true') || rtdbCompact.includes('".read":true,".write":true')) {
  console.error('OPEN RTDB ROOT RULES');
  failed = true;
}
if (/allow read, write:\s*if true/.test(fs) || /allow write:\s*if true/.test(fs)) {
  console.error('OPEN FIRESTORE RULE');
  failed = true;
}
if (/allow read, write:\s*if true/.test(st)) {
  console.error('OPEN STORAGE RULE');
  failed = true;
}
if (failed) process.exit(1);
console.log('assert-closed-rules: ok');
