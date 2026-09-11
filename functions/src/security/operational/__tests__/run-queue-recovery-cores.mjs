import { decideInvoiceWrite } from '../invoiceUpsertCore.ts';
import {
  decideProcessedPullReconcile,
  legacyIdemStorageKey,
  selectProcessedPullParent,
} from '../packetReconcileCore.ts';

let pass = 0, fail = 0;
const check = (n, ok) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`); };

check('create uses supplied id', decideInvoiceWrite({ invoiceId: 'docN', existing: null, driverId: 'd' }).result === 'created');
check('second create already_exists no write', decideInvoiceWrite({
  invoiceId: 'docN', mode: 'create', existing: { driverId: 'd' }, driverId: 'd',
}).write === false);
check('missing invoiceId invalid', decideInvoiceWrite({ invoiceId: '', existing: null, driverId: 'd' }).result === 'invalid');
check('storage key is not silent idem_ rewrite of canonical', legacyIdemStorageKey('20260909_192759_Gabriel1_9wxcta') === 'idem_20260909_192759_Gabriel1_9wxcta');

const PID = '20260909_192759_Gabriel1_9wxcta';
const LOCAL = { wellName: 'Gabriel 1', dateTimeUTC: 't', bblsTaken: 140, tankLevelFeet: 12 };
check('legacy idem_ match retires', decideProcessedPullReconcile({
  canonicalPacketId: PID, driverId: 'drv', companyId: 'liquid-gold', localIdentity: LOCAL,
  exact: null, legacyIdem: { ...LOCAL, driverId: 'drv', companyId: 'liquid-gold' },
}).location === 'legacy_idem');
check('mismatch does not match', decideProcessedPullReconcile({
  canonicalPacketId: PID, driverId: 'drv', companyId: 'liquid-gold', localIdentity: LOCAL,
  exact: null, legacyIdem: { ...LOCAL, bblsTaken: 1, driverId: 'drv', companyId: 'liquid-gold' },
}).match === false);
check('edit parent missing stays missing', selectProcessedPullParent({
  canonicalPacketId: PID, driverId: 'drv', companyId: 'liquid-gold', exact: null, legacyIdem: null,
}).reason === 'missing_original');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
