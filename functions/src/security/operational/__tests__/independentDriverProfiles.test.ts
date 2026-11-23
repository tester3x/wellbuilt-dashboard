import { parseIndependentDriverProfile, profileDocumentId } from '../independentDriverProfiles';

const profile = { driverKey: 'wellbuilt:marcial', primaryCustomerId: 'mongoose',
  standingWork: 'Regular route remains assigned to this driver.', sideJobs: 'yes',
  operatorNotes: [{ customerId: 'exxon', dispatchNote: 'Check timing.', operatorFeedback: '', reviewPending: true }] };

describe('Independent Dispatch driver profile input', () => {
  it('records standing work and nonbinding review notes for both driver sources', () => {
    expect(parseIndependentDriverProfile(profile)).toMatchObject(profile);
    expect(profileDocumentId('outside:isaac')).toBe('outside__isaac');
    expect(profileDocumentId('wellbuilt:marcial')).toBe('wellbuilt__marcial');
  });
  it('rejects injected decisions, duplicate customers, invalid driver keys, and oversized notes', () => {
    expect(() => parseIndependentDriverProfile({ ...profile, operatorNotes: [{ ...profile.operatorNotes[0], approved: true }] }))
      .toThrow('invalid_operator_note');
    expect(() => parseIndependentDriverProfile({ ...profile, operatorNotes: [profile.operatorNotes[0], profile.operatorNotes[0]] }))
      .toThrow('invalid_operator_note');
    expect(() => parseIndependentDriverProfile({ ...profile, driverKey: 'other:marcial' })).toThrow('invalid_driver_key');
    expect(() => parseIndependentDriverProfile({ ...profile, standingWork: 'a'.repeat(1001) })).toThrow('invalid_standing_work');
  });
});
