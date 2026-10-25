# Shift JSA backend rollout — 2026-10-18

Prepared source: shift context/lifecycle from67b4444f plus installed-client compatibility.

The existing JobDay callable names retain their original date/shift response shape and stored-request policy for installed WB T clients. The next WB T source uses distinct jsaRegisterJobShiftReadRequest, jsaResolveJobShiftEvidence, jsaAcknowledgeJobShift and jsaRecordJobShiftReadCoverage endpoints. Generic receipt handlers select policy from the stored request's server-owned jsaPeriodId, preserving legacy pending/completed receipts.

Deploy only the scoped JSA functions and the two added composite indexes. No database, Firestore or Storage rules deployment. Live rules were inspected read-only and default-deny the new JSA work-period collections. No APK build/install is requested. Authentication, new shift flows and legacy policy have regression checks; deployment verification will record ACTIVE revisions and signed-out denial without authoring production JSA or HOS records.

Status: deployment pending at this source checkpoint. See follow-up verification note for actual rollout results.
