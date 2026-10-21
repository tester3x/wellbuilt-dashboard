const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const stored = new Map([['wb_notification_prefs', JSON.stringify(['dispatch_update'])]]);
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/notifications.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
 { exports: exportsObject, localStorage: { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value) }, console });
assert(exportsObject.loadNotificationPrefs('admin').includes('sync_attention'), 'existing office preference lists must receive the new alert category');
exportsObject.saveNotificationPrefs(['dispatch_update']);
assert(!exportsObject.loadNotificationPrefs('admin').includes('sync_attention'), 'an explicit later preference choice is preserved');
stored.clear();
assert(!exportsObject.loadNotificationPrefs('driver').includes('sync_attention'));
assert(exportsObject.loadNotificationPrefs('manager').includes('sync_attention'));
console.log('Office alert preference migration, later choice preservation and driver defaults passed.');
