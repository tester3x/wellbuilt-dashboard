# Visible dispatch reassignment failures

Release branch: `release/dashboard-reassignment-alert-20261027`, based on freshly fetched approved Hosting checkpoint `e9f16671`. Preserves the deployed fresh-water work. Shared explicit-build authorization policy carried into this branch.

Reassignment errors were placed in the page-level banner while the reassignment modal remained open above it. The banner disappeared after five seconds. A driver starting a job after the dispatcher opened the modal could therefore leave the dispatcher without a visible explanation.

The submit handler now reads the current dispatch from the server before ownership/replacement writes. A started, paused, terminal, missing or unsupported-state job produces a persistent alert in the modal, including the well, driver and available stage. Empty started jobs require driver cancellation/return to queue; loaded jobs require the transfer workflow. Permission, network and server refusal errors remain visible until the dispatcher retries or closes the modal. The modal scrolls when its explanation would otherwise push controls off screen.

This is frontend validation and honest error presentation, not a new server permission or an atomic reassignment implementation. The existing server remains authoritative if state changes after the preflight read. No authentication, backend rule, active-job state or load-history changes are included.

Validation: 57 focused tests passed, including actual submit-handler execution with a stale pending modal and a newly started server job, zero mutation calls for blocked jobs, normal pending reassignment and persistent server-refusal handling. Additional mandatory Hosting checks and deployment verification remain pending at this checkpoint. No real assignment was submitted during these tests. The owner's requested phone-to-phone reassignment test remains for the owner; the empty test job was left assigned as instructed.

No Expo/EAS build or APK installation is part of this change.
