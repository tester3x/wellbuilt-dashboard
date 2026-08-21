export type InventoryStatus = 'secured' | 'fail_closed_blocker' | 'protocol_exception' | 'trigger';
export type InventoryAuth =
  | 'callable_auth_required'
  | 'public_protocol'
  | 'platform_admin'
  | 'platform_dual'
  | 'manageDrivers_staff_or_platform'
  | 'http_bearer_required'
  | 'trigger';
export type TenantGate =
  | 'none'
  | 'driver_company'
  | 'staff_company'
  | 'platform_dual'
  | 'public_protocol'
  | 'fail_closed'
  | 'driver_or_staff_viewTickets_or_platform_dual'
  | 'driver_or_staff_createDispatch_or_platform_dual';
export type InventorySurface = 'firebase_function' | 'non_function';

export interface HttpsInventoryEntry {
  name: string;
  kind: string;
  auth: InventoryAuth;
  tenant: TenantGate;
  status: InventoryStatus;
  surface: InventorySurface;
}

function e(
  name: string,
  kind: string,
  auth: InventoryAuth,
  tenant: TenantGate,
  status: InventoryStatus,
): HttpsInventoryEntry {
  return { name, kind, auth, tenant, status, surface: 'firebase_function' };
}

export const HTTPS_INVENTORY: HttpsInventoryEntry[] = [
  e('addSplitLeg', 'httpsV2.onCall', 'callable_auth_required', 'driver_or_staff_createDispatch_or_platform_dual', 'secured'),
  e('addTruthSwdReference', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('adminAddEntitlementOverride', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminApproveDriverRegistration', 'httpsV2.onCall', 'manageDrivers_staff_or_platform', 'staff_company', 'secured'),
  e('adminArchiveCompany', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminAssignCompanyPlan', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminAssignDriverAssignment', 'httpsV2.onCall', 'manageDrivers_staff_or_platform', 'staff_company', 'secured'),
  e('adminBindDriverCompany', 'httpsV2.onCall', 'manageDrivers_staff_or_platform', 'staff_company', 'secured'),
  e('adminComputeLegacyHash', 'httpsV2.onCall', 'manageDrivers_staff_or_platform', 'staff_company', 'secured'),
  e('adminCreatePlan', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminDeleteSecureDriver', 'httpsV2.onCall', 'manageDrivers_staff_or_platform', 'staff_company', 'secured'),
  e('adminDeprecatePlan', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminGetCompanyContractConfiguration', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminGetPlan', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminListAdminAudit', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminListPendingRegistrations', 'httpsV2.onCall', 'manageDrivers_staff_or_platform', 'staff_company', 'secured'),
  e('adminListPlans', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminPreviewCompanyEffectiveCapabilities', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminRejectDriverRegistration', 'httpsV2.onCall', 'manageDrivers_staff_or_platform', 'staff_company', 'secured'),
  e('adminRemoveEntitlementOverride', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminRetroCloseDriverShift', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminRetroCloseDriverShiftDryRun', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminSetCompanyAppConfiguration', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminSetCompanyContractEnforcement', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminSetCompanyWorkPeriodConfiguration', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminSetDriverPasscode', 'httpsV2.onCall', 'manageDrivers_staff_or_platform', 'staff_company', 'secured'),
  e('adminSyncStaffClaims', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminUpdateCompanySafe', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('adminUpdatePlan', 'httpsV2.onCall', 'platform_dual', 'platform_dual', 'secured'),
  e('approveTruthLocation', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('authenticateDriver', 'httpsV2.onCall', 'public_protocol', 'public_protocol', 'protocol_exception'),
  e('backfillTransferredTickets', 'functionsV1.https.onCall', 'callable_auth_required', 'fail_closed', 'fail_closed_blocker'),
  e('bootstrapDriverSession', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('checkDriverRegistrationStatus', 'httpsV2.onCall', 'public_protocol', 'public_protocol', 'protocol_exception'),
  e('claimDriverShift', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('cleanupExpiredPhotos', 'functionsV2.onSchedule', 'trigger', 'none', 'trigger'),
  e('closeDriverShift', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('createOrFindDispatchThread', 'httpsV2.onCall', 'callable_auth_required', 'fail_closed', 'fail_closed_blocker'),
  e('deactivateTruthSwdReference', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('demoClassifyLocations', 'httpsV2.onCall', 'public_protocol', 'public_protocol', 'protocol_exception'),
  e('dismissDispatch', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('driverChangeOwnPasscode', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('eQuipmentAssignments', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('eQuipmentDVIR', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('eQuipmentDocuments', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('eQuipmentEquipment', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('exportTruthRagForDay', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('finalizeStorageUpload', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('getDashboardReadModelForDay', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('getDriverReferenceBundle', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('getDriverWellConfig', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('getFieldCommandStatus', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('getIdentityHealthView', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('getIntegratedTruthForDay', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('getLocationHealthView', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('getPublicClientMeta', 'httpsV2.onCall', 'public_protocol', 'public_protocol', 'protocol_exception'),
  e('getRAGIngestBundleForDay', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('getShadowComparisonForDay', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('getTruthDriverDaySummary', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('getTruthDriverWeekSummary', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('getTruthRagExportRun', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('healthCheck', 'functionsV2.onSchedule', 'trigger', 'none', 'trigger'),
  e('ingestDriverPacket', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('inviteEmployee', 'httpsV2.onCall', 'manageDrivers_staff_or_platform', 'staff_company', 'secured'),
  e('issueStorageReadUrl', 'httpsV2.onCall', 'callable_auth_required', 'driver_or_staff_viewTickets_or_platform_dual', 'secured'),
  e('listStuckHandoffs', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('listTruthRagExports', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('listTruthSwdReference', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('materializeTransferredTicket', 'functionsV1.firestore', 'trigger', 'none', 'trigger'),
  e('materializerDriftHeartbeat', 'functionsV2.onSchedule', 'trigger', 'none', 'trigger'),
  e('onDispatchCreate', 'functionsV1.firestore', 'trigger', 'none', 'trigger'),
  e('onDispatchUpdate', 'functionsV1.firestore', 'trigger', 'none', 'trigger'),
  e('onProjectWrite', 'functionsV1.firestore', 'trigger', 'none', 'trigger'),
  e('onShiftCreate', 'functionsV1.firestore', 'trigger', 'none', 'trigger'),
  e('onShiftUpdate', 'functionsV1.firestore', 'trigger', 'none', 'trigger'),
  e('onUserWrite', 'functionsV1.database', 'trigger', 'none', 'trigger'),
  e('parseJsaPdf', 'httpsV2.onCall', 'callable_auth_required', 'fail_closed', 'fail_closed_blocker'),
  e('processDeleteRequest', 'functionsV1.database', 'trigger', 'none', 'trigger'),
  e('processEditRequest', 'functionsV1.database', 'trigger', 'none', 'trigger'),
  e('processIncomingPull', 'functionsV1.database', 'trigger', 'none', 'trigger'),
  e('recordDepartReturn', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('recoverHandoffOrphan', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('registerStandaloneDriver', 'httpsV2.onCall', 'callable_auth_required', 'fail_closed', 'fail_closed_blocker'),
  e('requestDriverRegistration', 'httpsV2.onCall', 'public_protocol', 'public_protocol', 'protocol_exception'),
  e('requestStorageUploadPath', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('rerunTruthRagExportForDay', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('resolveActiveDriverShift', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('revokeTruthLocationApproval', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('runMaterializerDriftScanOnDemand', 'functionsV1.https.onCall', 'platform_admin', 'platform_dual', 'secured'),
  e('runTransferRequestExpiryOnDemand', 'functionsV1.https.onCall', 'platform_admin', 'platform_dual', 'secured'),
  e('scheduledWellCatalogRefresh', 'functionsV2.onSchedule', 'trigger', 'none', 'trigger'),
  e('sendChatMessage', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('signalDriverLogout', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('ssoExchangeAuthorizationCode', 'httpsV2.onCall', 'public_protocol', 'public_protocol', 'protocol_exception'),
  e('ssoIssueAuthorizationCode', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('submitFieldCommand', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('submitJsaRecord', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('suggestPhotoCriteria', 'httpsV2.onCall', 'callable_auth_required', 'fail_closed', 'fail_closed_blocker'),
  e('transferRequestExpiry', 'functionsV2.onSchedule', 'trigger', 'none', 'trigger'),
  e('triggerDieselFetch', 'httpsV2.onRequest', 'http_bearer_required', 'fail_closed', 'fail_closed_blocker'),
  e('triggerWellCatalogRefresh', 'httpsV2.onCall', 'platform_admin', 'platform_dual', 'secured'),
  e('updateDriverProfile', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('upsertDriverDispatch', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('upsertDriverInvoice', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('upsertDriverShift', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('upsertPhotoRequirementSpec', 'httpsV2.onCall', 'callable_auth_required', 'staff_company', 'secured'),
  e('validatePhotoCompliance', 'httpsV2.onCall', 'callable_auth_required', 'fail_closed', 'fail_closed_blocker'),
  e('verifyDriverSession', 'httpsV2.onCall', 'callable_auth_required', 'driver_company', 'secured'),
  e('watchdogStrandedPackets', 'functionsV2.onSchedule', 'trigger', 'none', 'trigger'),
  e('weeklyDieselPriceFetch', 'functionsV2.onSchedule', 'trigger', 'none', 'trigger'),
  e('writeDiagnosticLog', 'httpsV2.onRequest', 'http_bearer_required', 'driver_company', 'secured'),
];

export function inventoryByName(name: string) {
  return HTTPS_INVENTORY.find((e) => e.name === name);
}

export function completeInventory(deployedNames: string[]): HttpsInventoryEntry[] {
  const missing: string[] = [];
  const out: HttpsInventoryEntry[] = [];
  for (const name of [...deployedNames].sort()) {
    const meta = inventoryByName(name);
    if (!meta) {
      missing.push(name);
      continue;
    }
    out.push(meta);
  }
  if (missing.length) {
    throw new Error(`inventory_missing_explicit_metadata:${missing.join(',')}`);
  }
  return out;
}
