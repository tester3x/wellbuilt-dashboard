// Mixed-generation Stage-A codebase (predeploy gate Rev-3 item 3). This is the
// EXACT function set that is live during the Stage-A deploy window:
//   NEW (just deployed, gated) producers:  ingestWbmPull, ingestWbmEdit, adminSubmitPullEdit
//   OLD (not yet replaced) consumers:       processIncomingPull, processEditRequest,
//                                           processDeleteRequest, watchdogStrandedPackets
//
// The producers are the REAL compiled functions from THIS branch's build
// (functions/lib). The consumers are the REAL compiled functions built from the
// pre-chrono source-family commit c7378d6 (NOT proven to be the deployed source;
// see docs/deployed-old-provenance.md), whose absolute lib path is supplied by the
// WB_OLD_LIB env var (the stagea run mode builds it into a throwaway worktree).
//
// EMULATOR-ONLY. Never referenced by firebase.json; never deployed.
const path = require('node:path');
const admin = require('firebase-admin');

// Both libs call admin.initializeApp() at load. The old worktree's node_modules
// is a junction to functions/node_modules, so this is the SAME admin singleton —
// make the second initializeApp idempotent instead of throwing duplicate-app.
const _init = admin.initializeApp.bind(admin);
admin.initializeApp = (...a) => {
  try { return _init(...a); } catch (e) {
    if (e && e.code === 'app/duplicate-app') return admin.app();
    throw e;
  }
};

const NEW_LIB = path.join(__dirname, '..', '..', 'lib', 'index.js'); // this branch's build
// The Functions emulator runtime does NOT inherit arbitrary parent env vars, so
// the old-lib path is handed over via a file the `stagea` prep writes.
let OLD_LIB = process.env.WB_OLD_LIB;
if (!OLD_LIB) {
  try { OLD_LIB = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '.old-lib.json'), 'utf8')).path; } catch { /* fall through */ }
}
if (!OLD_LIB) throw new Error('WB_OLD_LIB / .old-lib.json not set — the stagea run mode must build the old consumers first');

const newProducers = require(NEW_LIB);
const oldConsumers = require(OLD_LIB);

// NEW gated producers (this branch).
exports.ingestWbmPull = newProducers.ingestWbmPull;
exports.ingestWbmEdit = newProducers.ingestWbmEdit;
exports.adminSubmitPullEdit = newProducers.adminSubmitPullEdit;

// OLD deployed consumers (pre-chrono, still live during Stage A).
exports.processIncomingPull = oldConsumers.processIncomingPull;
exports.processEditRequest = oldConsumers.processEditRequest;
exports.processDeleteRequest = oldConsumers.processDeleteRequest;
exports.watchdogStrandedPackets = oldConsumers.watchdogStrandedPackets;
