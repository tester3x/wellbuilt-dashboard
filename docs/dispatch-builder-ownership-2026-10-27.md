# Job-builder ownership and queued reassignment test

Owner clarified that Dispatch must not reassign a driver-built job, including while queued. Server-owned `source: driver` and legacy `assignedBy: driver` / `driver:<id>` stamps identify these jobs. Assignment identity changes and stripping the legacy ownership stamp are rejected by the existing tenant-authorized staff update evaluator, including for platform administrators. Driver-managed/transfer flows are unchanged. This change does not broaden staff cancellation, ticket or history permissions.

The Dashboard preflight and persistent alert explain builder ownership before checking lifecycle state. A direct server refusal maps to the same human-readable explanation. A driver-owned queued job cannot invoke create/replacement or ownership-update calls through either reassignment UI path.

Validation: Functions TypeScript build and 61 focused backend ownership/authority/dispatch tests passed. All 59 focused Dashboard contract/handler checks passed. The live staff callable's two relevant pre-change source modules were downloaded and verified byte-identical to this branch before patching. Scoped deployment/verification will be recorded below; no broader function or rules release is authorized by this note.

The owner-authorized physical test used an existing dispatch-built pending job. It was visible in the ZFold drawer before reassignment and absent afterwards, with queued count changing from seven to six. It appeared automatically in the S24 drawer, queued count zero to one; no restart or new job acceptance was used. Server readback proves the same dispatch ID, exactly one active assignment for that well, unchanged total dispatch document count (264), preserved package/revision/hash binding and no invoice creation. Other active jobs were not cancelled or reassigned. Customer-specific before/after data and screenshots remain private outside Git.

No Expo/EAS cloud build or APK installation.
