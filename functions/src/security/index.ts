export {
  requestDriverRegistration,
  checkDriverRegistrationStatus,
  authenticateDriver,
  driverChangeOwnPasscode,
  adminListPendingRegistrations,
  adminApproveDriverRegistration,
  adminRejectDriverRegistration,
  adminSetDriverPasscode,
  adminDeleteSecureDriver,
  registerStandaloneDriver,
  adminComputeLegacyHash,
} from './driverAuthCallables';

/**
 * Governed initial company binding for a canonical secure driver — created
 * server-side so profile binding and shift authority can never disagree.
 * NOT deployed yet; selector: --only functions:adminBindDriverCompany
 */
export { adminBindDriverCompany } from './companyBindingCallable';
export { adminAssignDriverAssignment } from './assignDriverAssignmentCallable';
export { dismissDispatch } from './dismissDispatchCallable';

export {
  ingestDriverPacket,
  submitFieldCommand,
  upsertDriverShift,
  resolveActiveDriverShift,
  claimDriverShift,
  closeDriverShift,
  recordDepartReturn,
  submitJsaRecord,
  updateDriverProfile,
  signalDriverLogout,
  getDriverReferenceBundle,
  getDriverWellConfig,
  getFieldCommandStatus,
  requestStorageUploadPath,
  finalizeStorageUpload,
  issueStorageReadUrl,
  upsertDriverInvoice,
  upsertDriverDispatch,
  sendChatMessage,
  getPublicClientMeta,
} from './operational';

/** Authenticated cold-start secure session verification (side-effect free). */
export { verifyDriverSession } from './verifyDriverSession';
/** Authenticated post-SSO / post-login profile bootstrap. */
export { bootstrapDriverSession } from './sessionBootstrap';
