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
export {
  adminGetDashboardCatalog,
  adminGetWellPool,
  adminGetWellHistory,
  adminGetWellPerformance,
} from './adminDashboardCatalog';
export { dismissDispatch } from './dismissDispatchCallable';
export { staffWriteDispatch } from './staffWriteDispatchCallable';
export { staffWriteDriverAssignment } from './staffWriteDriverAssignmentCallable';
export { staffConvertApprovedDriverSecureLogin } from './staffConvertApprovedDriverSecureLogin';
export { upgradeOwnLegacyDriverLogin } from './upgradeOwnLegacyDriverLogin';
export { staffHydrateCanonicalIdentity } from './staffHydrateCanonicalIdentity';
export { staffRetireLegacyDriverLogin } from './staffRetireLegacyDriverLogin';
export { getOwnDriverHydration } from './getOwnDriverHydration';

export {
  ingestDriverPacket,
  ingestWbmPull,
  adminPreviewEstimationHold,
  adminApplyEstimationHold,
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
  bootstrapWbmSession,
  requestStorageUploadPath,
  upsertDriverInvoice,
  upsertDriverDispatch,
  sendChatMessage,
  getPublicClientMeta,
} from './operational';

/** Authenticated cold-start secure session verification (side-effect free). */
export { verifyDriverSession } from './verifyDriverSession';

export { adminSubmitPullEdit } from './dashboardPullEdit';
export {
  getTicketPaper,
  staffGetTicketPaper,
  staffMaterializeTicketPaper,
  getTicketPaperRoute,
  staffCorrectTicket,
  staffMutateTicketPaper,
  staffHandReviewToPayroll,
  staffHandTicketToPayroll,
  staffFinalizeReviewToBilling,
  staffFinalizeTicketToBilling,
  staffReopenTicketReview,
  staffReopenTicketPaper,
  staffHandReviewBatchToPayroll,
  staffHandReviewBatchToBilling,
} from './paperCallables';
