# Multi-task JSA settings checkpoint — 2026-09-15

Branch: feat/jsa-multi-task-templates-20260915.
Base: e3ce6450a61976e6e71b0eaf90539a6d294ed9af, matching desktop Dashboard committed HEAD and GitHub origin/integrate/wellpool-composite-writer-20260915. Desktop uncommitted well/dispatch edits are untouched.

Settings supports comma-separated applicable tasks per template. Different task wording uses separate active templates; identical wording can share one template assigned to multiple tasks. Empty assignments mean default assessment. Same-package overlapping task/default assignments reject publication. Activating Loading does not deactivate Unloading.

Activation writes a version snapshot in the existing templates collection with recordType=revision, filtered out of the editable list. Normal edit/delete APIs reject revision edits, active edits and deletion of previously published templates. Deactivate before editing and publish a new version. Draft reupload preserves package/task assignments unless explicitly changed. This client-side protection is not a security guarantee: existing Firestore template rules are permissive and must be replaced with governed company authorization and immutable-publication enforcement before rollout.

Catalog metadata is stored alongside the legacy top-level mirror. Task activation preserves that default mirror instead of silently changing what installed single-template clients read. Published versions and the current catalog update atomically in a Firestore transaction. Signed reports are untouched.

Validation: TypeScript passes; task-selection fixtures and transaction-adapter publication tests pass. Webpack production compilation and typechecking pass, but static export fails on existing /safety/spills/[incidentId] without generateStaticParams. Default Turbopack build also rejects the local node_modules junction; webpack was used to separate environment setup from compilation.

NOT deployed. No production templates changed in this checkpoint. Remaining end-to-end work: authenticated task catalog/version reads; JSA task selection and exact version evidence; govern publication and record creation/append so new wording requires review; Loading and Unloading parser fidelity and contacts; device read/sign/add/print tests; integrate with the current Dashboard release and resolve its existing static export failure before deployment. Do not broadly deploy Functions or rules from this branch. Preserve current deployed JSA/photo function lineage.
