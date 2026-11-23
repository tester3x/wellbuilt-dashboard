export type OperatorReviewNote = {
  customerId: string;
  dispatchNote: string;
  operatorFeedback: string;
  reviewPending: boolean;
};

export type IndependentDriverProfileInput = {
  driverKey: string;
  primaryCustomerId: string;
  standingWork: string;
  sideJobs: 'ask' | 'yes' | 'no';
  operatorNotes: OperatorReviewNote[];
};

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const DRIVER_KEY = /^(outside|wellbuilt):([A-Za-z0-9_-]{1,100})$/;

export function profileDocumentId(driverKey: string): string {
  const match = DRIVER_KEY.exec(driverKey);
  if (!match) throw Error('invalid_driver_key');
  return `${match[1]}__${match[2]}`;
}

/** Planning and review metadata only; this has no assignment eligibility effect. */
export function parseIndependentDriverProfile(raw: unknown): IndependentDriverProfileInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('invalid_driver_profile');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !['driverKey', 'primaryCustomerId', 'standingWork', 'sideJobs', 'operatorNotes'].includes(key)))
    throw Error('unexpected_driver_profile_field');
  if (typeof input.driverKey !== 'string') throw Error('invalid_driver_key');
  profileDocumentId(input.driverKey);
  if (typeof input.primaryCustomerId !== 'string' || (input.primaryCustomerId !== '' && !ID.test(input.primaryCustomerId)))
    throw Error('invalid_primary_customer');
  if (typeof input.standingWork !== 'string' || input.standingWork.length > 1000) throw Error('invalid_standing_work');
  if (!['ask', 'yes', 'no'].includes(input.sideJobs as string)) throw Error('invalid_side_jobs');
  if (!Array.isArray(input.operatorNotes) || input.operatorNotes.length > 20) throw Error('invalid_operator_notes');
  const ids = new Set<string>();
  const operatorNotes = input.operatorNotes.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_operator_note');
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => !['customerId', 'dispatchNote', 'operatorFeedback', 'reviewPending'].includes(key))
      || typeof row.customerId !== 'string' || !ID.test(row.customerId) || ids.has(row.customerId)
      || typeof row.dispatchNote !== 'string' || row.dispatchNote.length > 1000
      || typeof row.operatorFeedback !== 'string' || row.operatorFeedback.length > 1000
      || typeof row.reviewPending !== 'boolean') throw Error('invalid_operator_note');
    ids.add(row.customerId);
    return { customerId: row.customerId, dispatchNote: row.dispatchNote.trim(),
      operatorFeedback: row.operatorFeedback.trim(), reviewPending: row.reviewPending };
  });
  return { driverKey: input.driverKey, primaryCustomerId: input.primaryCustomerId,
    standingWork: input.standingWork.trim(), sideJobs: input.sideJobs as IndependentDriverProfileInput['sideJobs'], operatorNotes };
}
