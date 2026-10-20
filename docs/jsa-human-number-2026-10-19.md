# Human JSA numbers — coded, not deployed

Display format: JSA-YYYYMMDD-HHMMSS-NNNNNN, using the original signing/acknowledgement time in America/Chicago and a stable six-decimal reference suffix. The long canonical ID remains the lookup/authorization identity. Display numbers are not database keys.

New governed completions, standalone creates, and job acknowledgements store the human number. Resume, saved-job, shift-summary, weekly forms and standalone history project the same number for older records using their immutable source reference and original event time. Later shift acknowledgements reuse the first read's number; per-job policy keeps a separate reference. Existing assigned human numbers are preserved. No viewing-time timestamp, signature rewrite, lifecycle mutation, or calendar-based scope changes.

Validation: Functions TypeScript build and 88 JSA tests, 139 governed receipt checks, 64 job-acknowledgement checks and 46 standalone cases passed. Emulator-only end-to-end flow was not run (no emulator). No deployment. Client follow-ups are in JSA, WB T and Suite; cached opaque references show Pending sync until refreshed from the updated backend. Deploy only scoped JSA functions from the reviewed source, preserving unrelated live processor parity; never deploy rules as part of this change.
