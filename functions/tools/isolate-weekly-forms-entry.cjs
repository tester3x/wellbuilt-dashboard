// Run against an audited copy of the LIVE function source, never the broad
// dashboard package. It changes only main and adds the compiled entry point.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2], 'Provide the audited function source directory');
const file = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(pkg.main, 'lib/index.js', 'Unexpected prior runtime entry');
const entry = path.resolve(__dirname, '../lib/jsaReceipt/weeklyFormsEntry.js');
assert.ok(fs.existsSync(path.join(root, 'lib/jsaReceipt/jsaWeeklyFormsCallable.js')));
fs.copyFileSync(entry, path.join(root, 'lib/jsaReceipt/weeklyFormsEntry.js'));
pkg.main = 'lib/jsaReceipt/weeklyFormsEntry.js';
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
