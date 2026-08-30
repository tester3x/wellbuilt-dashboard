// fake-firebase.js — a stand-in for the firebase CLI, used ONLY by the
// execution-boundary test to exercise the controller's internal deploy spawn
// WITHOUT touching production. It records the exact argv it was called with,
// optionally rewrites the mock live-revisions file (simulating a deploy that
// changed revisions), and exits with a configurable code.
//
//   WB_FAKE_ARGV_FILE       — append the received argv (JSON line) here
//   WB_FAKE_EXIT            — process exit code (default 0)
//   WB_MOCK_REVISIONS_FILE  — the mock live-revisions file to (optionally) update
//   WB_FAKE_SET_REVISIONS   — JSON map to MERGE into the mock file (a "successful"
//                             deploy advancing revisions); omit to leave unchanged
const fs = require('node:fs');
const argv = process.argv.slice(2); // everything after: node fake-firebase.js ...
if (process.env.WB_FAKE_ARGV_FILE) {
  fs.appendFileSync(process.env.WB_FAKE_ARGV_FILE, JSON.stringify(argv) + '\n');
}
if (process.env.WB_FAKE_SET_REVISIONS && process.env.WB_MOCK_REVISIONS_FILE) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(process.env.WB_MOCK_REVISIONS_FILE, 'utf8')); } catch { /* fresh */ }
  const upd = JSON.parse(process.env.WB_FAKE_SET_REVISIONS);
  fs.writeFileSync(process.env.WB_MOCK_REVISIONS_FILE, JSON.stringify({ ...cur, ...upd }));
}
process.exit(Number(process.env.WB_FAKE_EXIT || '0'));
