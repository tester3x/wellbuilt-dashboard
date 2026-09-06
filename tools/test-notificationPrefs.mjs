/**
 * Guard: every supported UserRole has explicit DEFAULT_PREFS.
 * Run: node --experimental-strip-types tools/test-notificationPrefs.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(join(root, rel), 'utf8');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const authSrc = src('src/lib/auth.ts');
const notifSrc = src('src/lib/notifications.ts');

const userRoleMatch = authSrc.match(/export type UserRole = ([^;]+);/);
check('UserRole union is present', Boolean(userRoleMatch));
const userRoles = userRoleMatch
  ? [...userRoleMatch[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()
  : [];
check('UserRole includes safety and lead', userRoles.includes('safety') && userRoles.includes('lead'));

const extractRecordKeys = (text, exportName) => {
  const m = text.match(new RegExp(`export const ${exportName}[^=]*= \\{([\\s\\S]*?)\\n\\};`));
  if (!m) return [];
  return [...m[1].matchAll(/^\s*([a-z]+):/gm)].map((x) => x[1]).sort();
};

const extractPrefMap = (text) => {
  const m = text.match(/export const DEFAULT_PREFS: Record<UserRole, NotificationCategory\[]> = \{([\s\S]*?)\n\};/);
  if (!m) return {};
  const map = {};
  for (const mm of m[1].matchAll(/^\s*([a-z]+):\s*\[([^\]]*)\]/gm)) {
    map[mm[1]] = mm[2]
      .split(',')
      .map((s) => s.trim().replace(/['"]/g, ''))
      .filter(Boolean);
  }
  return map;
};

const sameKeys = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

const roleLevels = extractRecordKeys(authSrc, 'ROLE_LEVELS');
const roleCaps = extractRecordKeys(authSrc, 'DEFAULT_ROLE_CAPABILITIES');
const roleLabels = extractRecordKeys(authSrc, 'DEFAULT_ROLE_LABELS');
const prefMap = extractPrefMap(notifSrc);
const prefKeys = Object.keys(prefMap).sort();

check('ROLE_LEVELS keys match UserRole', sameKeys(roleLevels, userRoles), `${roleLevels.join(',')} vs ${userRoles.join(',')}`);
check('DEFAULT_ROLE_CAPABILITIES keys match UserRole', sameKeys(roleCaps, userRoles));
check('DEFAULT_ROLE_LABELS keys match UserRole', sameKeys(roleLabels, userRoles));
check('DEFAULT_PREFS keys match UserRole', sameKeys(prefKeys, userRoles), `${prefKeys.join(',')} vs ${userRoles.join(',')}`);

for (const role of userRoles) {
  check(`${role} has explicit DEFAULT_PREFS array`, Array.isArray(prefMap[role]));
}

const SAFETY_LEAD_DEFAULTS = ['dispatch_update', 'well_alert', 'ticket_submitted'];
const sameList = (a, b) => a.length === b.length && a.every((v) => b.includes(v));
check('safety defaults match Safety/dispatch/ticket capabilities', sameList(prefMap.safety || [], SAFETY_LEAD_DEFAULTS), JSON.stringify(prefMap.safety));
check('lead defaults match Safety/dispatch/ticket capabilities', sameList(prefMap.lead || [], SAFETY_LEAD_DEFAULTS), JSON.stringify(prefMap.lead));
check('safety does not get driver_registration', !(prefMap.safety || []).includes('driver_registration'));
check('lead does not get driver_registration', !(prefMap.lead || []).includes('driver_registration'));
check('safety does not get payroll_dispute', !(prefMap.safety || []).includes('payroll_dispute'));
check('lead does not get payroll_dispute', !(prefMap.lead || []).includes('payroll_dispute'));
check('driver remains empty prefs', Array.isArray(prefMap.driver) && prefMap.driver.length === 0);
check('existing dispatch prefs unchanged', sameList(prefMap.dispatch || [], ['dispatch_update', 'pull_submitted', 'ticket_submitted']));
check('existing admin prefs unchanged', sameList(prefMap.admin || [], ['driver_registration', 'dispatch_update', 'well_alert']));

const safetyCaps = authSrc.match(/safety:\s*\[([\s\S]*?)\],\s*lead:/);
const leadCaps = authSrc.match(/lead:\s*\[([\s\S]*?)\],\s*payroll:/);
check('safety and lead capability blocks exist', Boolean(safetyCaps && leadCaps));
if (safetyCaps && leadCaps) {
  const has = (block, cap) => block.includes(`'${cap}'`);
  for (const cap of ['viewSafety', 'manageSafety', 'viewDispatch', 'viewTickets']) {
    check(`safety has ${cap}`, has(safetyCaps[1], cap));
    check(`lead has ${cap}`, has(leadCaps[1], cap));
  }
  check('safety does not have manageDrivers', !has(safetyCaps[1], 'manageDrivers'));
  check('lead does not have manageDrivers', !has(leadCaps[1], 'manageDrivers'));
  check('safety does not have approvePayroll', !has(safetyCaps[1], 'approvePayroll'));
  check('lead does not have approvePayroll', !has(leadCaps[1], 'approvePayroll'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
