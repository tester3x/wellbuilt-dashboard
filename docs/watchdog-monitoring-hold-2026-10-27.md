# Monitoring-only hold operation

Two exclusive well-intake groups were put on hold at the owner's requested effective times. This is an operational configuration change, with no source deployment. Customer-specific names, timestamps, saved channel configurations, receipts and backups remain in private operational evidence outside Git.

The existing Stop endpoint also publishes a well-down packet. To honor a monitoring-only hold, each exclusive channel was removed from the server intake allowlist and the HP's persisted capture-channel selection instead. The original server channel configuration and effective cutoff are retained in the policy's `heldWells` record for deliberate restoration. The original HP channel settings are privately backed up. Resume requires restoring both selections; the receiver's overall startup/watch state remains active.

Verification: signed intake requests for each held channel return `channel_not_allowed` before parsing a pull. The HP's persisted channel file has eight remaining channels, receiver Connected/unpaused and transport Ready. All unrelated channel configurations were asserted unchanged. Existing completed local receipts, well configurations, outgoing responses and the audited processed history are unchanged. No histories were deleted, no down-status packet was generated, and no WhatsApp messages were sent as part of this operation.

A subsequent comparison of one group's description with its existing tank record found a calibration mismatch. That comparison was read-only; no tank, minimum-level or AFR changes were applied without settling that separate change.


## One-shot report-driven resume

Product change: a signed intake request may atomically restore an explicitly armed, exclusive held channel on a new matching load/level observation. Its WhatsApp post time must be strictly after the saved arming time; its measurement must follow the original hold cutoff. Chatter, other wells, malformed levels, future observations, archived wells and review overrides cannot consume the arm. The restored channel retains its original options and a durable post-time cutoff, so retrying the first report uses the ordinary packet identity and old backlog cannot create new pulls. Tank records, down state and AFR configuration are not changed by restoration.

Lifecycle exposes held metadata to the receiver. The worker skips old/unarmed held observations and the management panel labels the waiting state. The selected armed group must remain captured on HP; unarmed held groups stay deselected. No scheduled Codex task or laptop process is required.

Validation: TypeScript build passed. Four focused parser/signed-handler tests and seven worker/receipt checks passed; the existing 66 worker checks passed. The prepared live-archive ingest and lifecycle modules also passed the signed-handler first-report/retry/backlog test. Six older intake-suite decimal-notation assertions fail identically against the unchanged baseline (23 baseline checks pass); these are not represented as passing. Deployments must surgically patch each function's own downloaded live source, preserving all other files and runtime/security configuration. Deployment and HP activation results follow in a separate acceptance checkpoint.


Acceptance: product checkpoint `42a1adc3` committed/pushed and fast-forwarded on HP without replacing its branch or untracked operational files. Both scoped Functions are ACTIVE: `ingestwatchdogpullv2-00041-muw` and `getwatchdogwelllifecyclev2-00002-yay`. Their downloaded active source archives byte-match the audited candidates; unrelated archive files and runtime/environment/secrets/service-account/ingress settings are preserved. No Hosting or rules deployment.

HP passed the seven new hold/receipt checks and restarted through its existing supervisor. Verified Connected, unpaused, transport Ready and fresh receiver checks with nine captured groups. Only the explicitly armed held group was restored for listening; the other held group stays deselected and unarmed. Signed empty observations cannot resume either hold. All existing completed HP receipts, both well configurations, outgoing responses and the audited processed history remain unchanged. The one-shot arm remains waiting for a real qualifying report; no synthetic production load or WhatsApp message was submitted. The worker runs independently of the laptop using its existing persistent startup configuration.
