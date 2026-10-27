# Monitoring-only hold operation

Two exclusive well-intake groups were put on hold at the owner's requested effective times. This is an operational configuration change, with no source deployment. Customer-specific names, timestamps, saved channel configurations, receipts and backups remain in private operational evidence outside Git.

The existing Stop endpoint also publishes a well-down packet. To honor a monitoring-only hold, each exclusive channel was removed from the server intake allowlist and the HP's persisted capture-channel selection instead. The original server channel configuration and effective cutoff are retained in the policy's `heldWells` record for deliberate restoration. The original HP channel settings are privately backed up. Resume requires restoring both selections; the receiver's overall startup/watch state remains active.

Verification: signed intake requests for each held channel return `channel_not_allowed` before parsing a pull. The HP's persisted channel file has eight remaining channels, receiver Connected/unpaused and transport Ready. All unrelated channel configurations were asserted unchanged. Existing completed local receipts, well configurations, outgoing responses and the audited processed history are unchanged. No histories were deleted, no down-status packet was generated, and no WhatsApp messages were sent as part of this operation.

A subsequent comparison of one group's description with its existing tank record found a calibration mismatch. That comparison was read-only; no tank, minimum-level or AFR changes were applied without settling that separate change.
