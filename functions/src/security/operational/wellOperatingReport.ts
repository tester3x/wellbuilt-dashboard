import * as admin from 'firebase-admin';
import { HttpsError } from 'firebase-functions/v2/https';
import { deliverLevelReport } from '../../levelReportDelivery';

export type OperatingReportContext = { jobId: string; levels: Record<string, number> | null };
export function checkedOperatingLevels(raw: any): Record<string, number> | null {
  if (raw == null) return null;
  const { tankTopInches: top, tankAfterInches: bottom, bblsTaken: bbls } = raw;
  if (![top, bottom, bbls].every(v => typeof v === 'number' && Number.isFinite(v))
    || top <= 0 || top > 1200 || bottom < 0 || bottom > top || bbls < 0 || bbls > 100000)
    throw new HttpsError('invalid-argument', 'Invalid status-change level context');
  return { tankTopInches: top, tankAfterInches: bottom, bblsTaken: bbls };
}
/** A report is tied to the authenticated driver's exact job, not a supplied
 * sender/name/company. Legacy clients remain compatible but cannot fabricate a
 * report for a different driver's job. This never changes the job or pickup. */
export async function operatingReportContext(data: any, companyId: string, driverId: string, key: string, config: any): Promise<OperatingReportContext | undefined> {
  // Old queued intents are never opted into a new notification on replay.
  if (data.reportVersion !== 1) return undefined;
  if (typeof data.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(data.jobId))
    throw new HttpsError('invalid-argument', 'Invalid status-change job');
  const snap = await admin.firestore().doc(`invoices/${data.jobId}`).get();
  const job = snap.data();
  if (!job) throw new HttpsError('failed-precondition', 'Status change is waiting for its saved job');
  const names = [key, config.ndicName].filter(Boolean).map(n => String(n).trim().toLowerCase());
  if (job.companyId !== companyId || job.driverHash !== driverId
    || (job.wellConfigKey ? job.wellConfigKey !== key : !names.includes(String(job.wellName || '').trim().toLowerCase())))
    throw new HttpsError('permission-denied', 'Status-change job does not match its driver, company or well');
  return { jobId: data.jobId, levels: checkedOperatingLevels(data.levelReport) };
}

/** Called as part of the existing durable status operation, not by a polling
 * loop or a retrying database trigger. A lost response retries the same message
 * ID; the existing Firestore transaction creates it at most once per thread. */
export async function deliverOperatingReport(companyId: string, actor: string, operationId: string) {
  const ref = admin.database().ref(`wellOperatingOperations/${companyId}/${operationId}`);
  const row = (await ref.once('value')).val();
  if (!row || row.actor !== actor || row.companyId !== companyId || row.status !== 'applied'
    || row.previousDown === row.down || !row.reportContext || row.reportDelivery) return;
  const packet = { ...row.reportContext.levels, wellName: row.wellConfigKey, companyId, driverId: actor,
    dateTimeUTC: row.at, wellDownIsAuthoritative: true, wellDown: row.down,
    noLevel: !row.reportContext.levels };
  const outcome = await deliverLevelReport(packet, `well_status_${operationId}`);
  if (!['delivered', 'disabled'].includes(outcome.result)) throw new Error('Well status dispatch report is not confirmed');
  await ref.update({ reportDelivery: { result: outcome.result, at: new Date().toISOString() } });
}
