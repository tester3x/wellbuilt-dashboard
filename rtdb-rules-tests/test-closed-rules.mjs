/**
 * Negative rules matrix for the default-deny RTDB/Firestore/Storage files.
 * Run via firebase emulators:exec after wiring firebase.json to the secure files.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rtdb = readFileSync(join(root, 'database.rules.json'), 'utf8');
const fs = readFileSync(join(root, 'firestore.rules'), 'utf8');
const st = readFileSync(join(root, 'storage.rules'), 'utf8');
const fj = JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8'));

assert.equal(fj.database.rules, 'database.rules.json');
assert.equal(fj.firestore.rules, 'firestore.rules');
assert.equal(fj.storage.rules, 'storage.rules');
assert.ok(String(fj.database.predeploy).includes('assert-closed-rules'));

assert.ok(!rtdb.replace(/\s+/g, '').includes('"rules":{".read":true'));
assert.ok(rtdb.includes('".read": false'));
assert.ok(rtdb.includes('"incoming"'));
assert.match(rtdb, /packets[\s\S]*incoming[\s\S]*"\.write": false/);

assert.ok(!/allow read, write:\s*if true/.test(fs));
assert.match(fs, /driver_credentials[\s\S]*allow read, write: if false/);
assert.match(fs, /match \/\{document=\*\*\}/);

assert.ok(!/allow read, write:\s*if true/.test(st));
assert.match(st, /match \/\{allPaths=\*\*\}/);

console.log('closed-rules source pins: ok');
