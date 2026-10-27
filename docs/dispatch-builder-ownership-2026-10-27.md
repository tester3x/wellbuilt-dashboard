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
