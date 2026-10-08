import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from './requireDriverAuth';
import { BINDING_BY_DRIVER, parseBinding } from './operational/identityBinding';
import { decideTrustedHistoryKeys } from './operational/trustedHistoryAlias';
import { parsePayrollWindow, projectOwnPayConfig, projectOwnPayrollInvoice } from './operational/driverPayroll';

/** Owner-scoped payroll read for Suite. Firestore rules cannot authorize a
 * company-wide client query followed by local driver filtering. */
export const getDriverPayroll = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    if (!driver.companyId) throw new httpsV2.HttpsError('failed-precondition', 'unscoped_driver');
    const input = request.data;
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['startISO', 'endISO'].includes(key))) {
      throw new httpsV2.HttpsError('invalid-argument', 'payroll_window_invalid');
    }
    const window = parsePayrollWindow(input);
    if (!window) throw new httpsV2.HttpsError('invalid-argument', 'payroll_window_invalid');

    const binding = parseBinding(
      (await admin.database().ref(BINDING_BY_DRIVER(driver.driverId)).once('value')).val(),
    );
    const trusted = decideTrustedHistoryKeys({ authenticatedDriverId: driver.driverId, binding });
    if (trusted.action !== 'ok') throw new httpsV2.HttpsError('permission-denied', 'alias_spoof');

    const db = admin.firestore();
    const companyId = driver.companyId;
    const [invoiceSnap, companySnap] = await Promise.all([
      db.collection('invoices')
        .where('companyId', '==', companyId)
        .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(window.start))
        .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(window.end))
        .limit(1001).get(),
      db.collection('companies').doc(companyId).get(),
    ]);
    if (invoiceSnap.size > 1000) {
      throw new httpsV2.HttpsError('resource-exhausted', 'payroll_window_too_large');
    }
    if (!companySnap.exists) throw new httpsV2.HttpsError('failed-precondition', 'payroll_company_missing');

    const invoices = invoiceSnap.docs
      .map(doc => projectOwnPayrollInvoice(doc.id, doc.data(), companyId, trusted.keys))
      .filter((row): row is Record<string, unknown> => row !== null)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return { invoices, payConfig: projectOwnPayConfig(companySnap.data() || {}) };
  },
);
