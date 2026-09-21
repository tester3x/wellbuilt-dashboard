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
  requestCompanyOnboarding,
  adminListCompanyOnboardingRequests,
  adminApproveCompanyOnboarding,
  adminCreateCompanyWithJoinCode,
  getCompanyJoinCode,
  rotateCompanyJoinCode,
  rotateJoinCode,
  executeRotateJoinCode,
  decideRotateCompanyJoinCodeTenantAccess,
  decideRotateCompanyJoinCodeAccess,
  decideGetCompanyJoinCodeTenantAccess,
  decideGetCompanyJoinCodeAccess,
} from './companyOnboarding';
export {
  adminGetDashboardCatalog,
  adminGetWellPool,
  adminGetWellHistory,
  adminGetWellPerformance,
} from './adminDashboardCatalog';
export { dismissDispatch } from './dismissDispatchCallable';
export { staffWriteDispatch } from './staffWriteDispatchCallable';
export { createDriverDispatchIfAbsent } from './createDriverDispatchCallable';
export { acceptDriverDispatch } from './acceptDriverDispatchCallable';
export { publishJobPacketRevision } from './jobPacketPublishCallable';
export { staffWriteRoleCapabilities } from './staffWriteRoleCapabilitiesCallable';
export { staffWriteDriverAssignment } from './staffWriteDriverAssignmentCallable';
export { staffWriteWellConfig } from './staffWriteWellConfigCallable';
export { staffWriteUserRoles } from './staffWriteUserRolesCallable';
export { staffConvertApprovedDriverSecureLogin } from './staffConvertApprovedDriverSecureLogin';
export { upgradeOwnLegacyDriverLogin } from './upgradeOwnLegacyDriverLogin';
export { staffHydrateCanonicalIdentity } from './staffHydrateCanonicalIdentity';
export { staffRetireLegacyDriverLogin } from './staffRetireLegacyDriverLogin';
export { getOwnDriverHydration } from './getOwnDriverHydration';

export {
  ingestDriverPacket,
  ingestWbmPull,
  ingestWbmEdit,
  upsertDriverShift,
  resolveActiveDriverShift,
  staffResolveCompanyDriverShifts,
  claimDriverShift,
  closeDriverShift,
  recordDepartReturn,
  submitJsaRecord,
  updateDriverProfile,
  signalDriverLogout,
  getDriverReferenceBundle,
  getDriverWellConfig,
  getDriverOutgoingStatus,
  getDriverWellPerformance,
  bootstrapWbmSession,
  requestStorageUploadPath,
  upsertDriverInvoice,
  upsertDriverDispatch,
  sendChatMessage,
  getPublicClientMeta,
} from './operational';

/** Authenticated cold-start secure session verification (side-effect free). */
export { verifyDriverSession } from './verifyDriverSession';
