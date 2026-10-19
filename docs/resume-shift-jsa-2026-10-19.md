# Resume shift JSA — 2026-10-19

Branch: feat/jsa-register-join-code-20260917.

Current-JSA presentation now recovers assessment text from the exact owned local submitted record, matching governed request ID, all authored snapshot fields and PNG. Topic IDs must exactly match the signed acknowledgements. It never changes receipt, signature, shift status or acknowledgement evidence. Without that archive it explicitly reports missing original text instead of substituting the nine-topic current built-in template.

Backend jsaHomeState supplies company branding, owned original job and shift-scoped acknowledgements linked to this exact full read. Document shows job/type/drop-off and acknowledgement times. Opaque generated references are compacted on home, document and footer; stable backend IDs remain unchanged. Date/sequence allocation is not implemented by this change.

Read-only live source check: company name resolved, five linked jobs returned. Gabriel 7 acknowledgement exists at 2026-10-19 16:06:29 America/Chicago, linked to the 10:25:13 full read. No evidence changed. Device logs captured privately; no private data committed.

Validation: app typecheck; document, projection and home-client tests; backend build and 13 home-state tests passed. Device rendering still needs next APK. Original assessment text was not archived in the existing server snapshot; recovery depends on the matching saved local record. Missing local text is disclosed, never reconstructed from current policy.

Committed/pushed source only. Not built, installed or deployed. Backend changes are on release/dashboard-compact-identity-20261015.
