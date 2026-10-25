# Shift JSA deployment verification — 2026-10-18

Backend source:297775ec. The later dc655405 commit changes Watchdog UI only; its functions tree is identical. Verification: 2026-10-19T03:31:28.288Z.

All 17 scoped functions are ACTIVE. All 16 callables reject signed-out requests with401. The automatic finalizer is a Firestore written trigger on driver_shift_authority/{driverId}, scoped to the default database/namespace. Initial Eventarc service-agent propagation delayed its creation; its existing required role was verified, and a targeted retry succeeded without IAM changes.

Installed clients retain the old JobDay endpoints and response shapes. The next WB T source 2877629 selects the new JobShift endpoints. Receipt handlers distinguish legacy and new requests by the server-stored JSA context. No APK built/installed, no security rules deployed, and no production JSA/HOS records authored or repaired during deployment.

Two additive composite indexes were submitted separately through the Firestore Admin API, without deleting or modifying existing indexes. Both indexes are verified READY after successful creation.

| Function | Revision | State | Signed-out HTTP |
|---|---|---|---|
| jsaRegisterJobShiftReadRequest | jsaregisterjobshiftreadrequest-00001-duz | ACTIVE | 401 |
| jsaResolveJobShiftEvidence | jsaresolvejobshiftevidence-00001-wok | ACTIVE | 401 |
| jsaAcknowledgeJobShift | jsaacknowledgejobshift-00001-veb | ACTIVE | 401 |
| jsaRecordJobShiftReadCoverage | jsarecordjobshiftreadcoverage-00001-buj | ACTIVE | 401 |
| jsaRegisterJobReadRequest | jsaregisterjobreadrequest-00002-pem | ACTIVE | 401 |
| jsaResolveJobReadEvidence | jsaresolvejobreadevidence-00002-bid | ACTIVE | 401 |
| jsaAcknowledgeJobDay | jsaacknowledgejobday-00002-noh | ACTIVE | 401 |
| jsaRecordJobReadCoverage | jsarecordjobreadcoverage-00002-pen | ACTIVE | 401 |
| jsaRegisterReadRequest | jsaregisterreadrequest-00005-xil | ACTIVE | 401 |
| jsaGetReadRequest | jsagetreadrequest-00006-vaw | ACTIVE | 401 |
| jsaPersistGovernedArtifact | jsapersistgovernedartifact-00004-joh | ACTIVE | 401 |
| jsaCompleteReadRequest | jsacompletereadrequest-00004-kej | ACTIVE | 401 |
| jsaConsumeReadResult | jsaconsumereadresult-00004-juy | ACTIVE | 401 |
| jsaGetSavedJob | jsagetsavedjob-00002-dug | ACTIVE | 401 |
| jsaStandalone | jsastandalone-00006-hec | ACTIVE | 401 |
| jsaWeeklyForms | jsaweeklyforms-00003-nol | ACTIVE | 401 |
| jsaFinalizeShiftContext | jsafinalizeshiftcontext-00001-ces | ACTIVE | event trigger |

Validation:51 JSA unit cases,46 standalone server cases,16 WB T runtime flows, application typechecks and the previous local emulator checks passed. Authenticated phone testing remains for the requested future APKs.
