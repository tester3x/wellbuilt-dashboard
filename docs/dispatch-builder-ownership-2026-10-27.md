# Job-builder ownership and queued reassignment test

Owner clarified that Dispatch must not reassign a driver-built job, including while queued. Server-owned `source: driver` and legacy `assignedBy: driver` / `driver:<id>` stamps identify these jobs. Assignment identity changes and stripping the legacy ownership stamp are rejected by the existing tenant-authorized staff update evaluator, including for platform administrators. Driver-managed/transfer flows are unchanged. This change does not broaden staff cancellation, ticket or history permissions.

The Dashboard preflight and persistent alert explain builder ownership before checking lifecycle state. A direct server refusal maps to the same human-readable explanation. A driver-owned queued job cannot invoke create/replacement or ownership-update calls through either reassignment UI path.

Validation: Functions TypeScript build and 61 focused backend ownership/authority/dispatch tests passed. All 59 focused Dashboard contract/handler checks passed. The live staff callable's two relevant pre-change source modules were downloaded and verified byte-identical to this branch before patching. Scoped deployment/verification will be recorded below; no broader function or rules release is authorized by this note.

The owner-authorized physical test used an existing dispatch-built pending job. It was visible in the ZFold drawer before reassignment and absent afterwards, with queued count changing from seven to six. It appeared automatically in the S24 drawer, queued count zero to one; no restart or new job acceptance was used. Server readback proves the same dispatch ID, exactly one active assignment for that well, unchanged total dispatch document count (264), preserved package/revision/hash binding and no invoice creation. Other active jobs were not cancelled or reassigned. Customer-specific before/after data and screenshots remain private outside Git.

No Expo/EAS cloud build or APK installation.

## Deployed and verified

Source checkpoint `848acfe94cdc2c5bf3e84217834e71d2c54fdf72` committed and pushed. The existing `staffWriteDispatch` function alone was updated by patching its own downloaded source archive: only the ownership module's TypeScript, compiled JS and map changed; all 962 other entries were preserved. Active revision `staffwritedispatch-00011-xev` was independently downloaded and every source-archive entry matches the verified candidate. All existing build/runtime, environment, service-account, ingress, timeout, memory, concurrency and other service settings were asserted unchanged.

The Dashboard was released through its normal certified Hosting path. Clean compilation, 484 library tests (one existing skip) and all retained-behavior/browser/layout checks passed. The postdeploy hook verified all 381 live artifacts against exact source `848acfe94cdc2c5bf3e84217834e71d2c54fdf72` at 2026-10-27 15:04:13 UTC, advanced the shared approved checkpoint and released its lock. No other Functions or rules deployment.

Both phones remained running during the successful queued-job reassignment test. The target stays queued on the S24; it was not accepted, started or moved back. The separate driver-built active job stayed with its original builder.

## Physical queued driver-built refusal test

Created one genuine pending job through the installed S24 Job Planner using an existing synthetic test well; no job was started and no load was submitted. Server readback confirmed the server-owned driver provenance and original S24 assignment before testing. In live Well Queue, selected the ZFold as recipient and submitted Reassign once. The modal stayed open with a persistent explanation that the original builder owns the job and Dispatch cannot reassign it even while queued.

After the blocked attempt, the complete test dispatch document was unchanged, total dispatch document count stayed 265, no new dispatch IDs appeared, and exactly one active card for the test well remained assigned to its original builder. The running S24 drawer visibly retained that queued card. The ZFold was being used in WhatsApp, so its screen was left untouched; server readback confirms no assignment to it. The test card remains queued on S24 for inspection. Private server snapshots and screenshots are outside Git. No build, install or deployment was needed for this acceptance test.

## Cleanup and policy clarification

At the owner's request, declined only the synthetic queued card through its S24 drawer with a test-complete reason. Server confirmed declined and the card disappeared automatically. The dispatch-built queued card remains pending and the separate in-progress job remains en route to drop-off. Neither was acted on during cleanup.

The owner clarified that drivers must not gain ordinary job reassignment authority; driver load transfers remain a separate supported workflow. Dispatch should create a separate job for another driver rather than reassign a driver-built queued card. Transfer initiation and approval must respect company operations settings (standalone, dispatch-only or driver/dispatch hybrid); these differ from the invoice/ticket formatting setting also called hybrid. Existing settings have separate `liveDispatchSync` and `transferRequiresApproval` controls. No company setting or transfer permission was changed during this cleanup. Follow-up: replace the ownership alert's ambiguous builder-management suggestion with the separate-job instruction, and audit transfer approval enforcement before changing that workflow.

## Transfer settings audit (2026-10-27)

The transfer audit confirmed that dispatch-only and driver/dispatch hybrid do not automatically force approval: approval is an independent company flag. The deployed driver create/accept and staff transfer handler bytes match the inspected checkouts. The modular WB T transfer path ignores the approval flag when a driver selects a recipient, and the server trusts that direct mode without consulting the company flag. Loopback emulator scenarios reproduced required-approval bypass in both dispatch modes (and standalone). This is an outstanding enforcement gap, not an accepted policy or passing approval regression.

Explicit approval requests worked in both dispatch modes: receiver remained unset until trusted staff assignment, viewers/drivers could not assign, sender ownership remained until authenticated receiver acceptance, original PW pickup identity remained, and there was one dispatch with preserved driver-built origin. This legitimate transfer path does not grant ordinary reassignment authority. The live staffWriteDispatch ownership evaluator was independently downloaded and byte-matched; builder-origin/staff-authority tests passed 25 checks. No runtime settings, jobs, permissions, Functions, Hosting or rules were changed by this audit.

Detailed diagnostics and reproduction live in the WB T laptop branch `codex/wbt-enroute-20261014`, `docs/dispatch-transfer-settings-audit-2026-10-27.md` and `tools/audit-transfer-{dispatch,client}-policy.cjs`. Follow-up should enforce the existing company approval flag on the server and both clients, fix the legacy dispatch-request stale-state issue, and clarify the ownership alert. Automatically coupling approval to dispatch-only versus hybrid is a separate product-policy decision; it was not silently introduced.
