# Well search presentation checkpoint

Branch: release/dashboard-compact-identity-20261015. Based on 6a840787.

Search results use the existing governed company well pool, classifyWell and
compareQueueRows. Exact/prefix name relevance remains ahead of queue urgency;
the result cap follows ranking. Exact canonical/NDIC aliases share a reading;
ambiguous aliases and unmaintained locations do not receive invented levels.
Current estimated levels appear at the right, including DOWN where applicable.
Heavy Water retains its explicit weight ordering. Generic operator lists retain
their order. Keyboard selection resets when result identities/order change.

Covered surfaces: Dispatch shared location/catalog rows and builders, completed
job editing, driver destination search, and shared Add Pull well search.
The shared Add Pull change also applies on Mobile Well Status and Well History.

Validation so far: TypeScript passes; new presentation tests 2/2 pass. Full lib
suite: 412 pass, 4 existing failures (callable inventory and three extensionless
Node import failures), 1 skipped. Hosting preflight and visual validation pending.
Not deployed at this checkpoint. WB Tickets counterpart is a separate source
checkpoint; it is not included in Hosting and requires a later APK.

Ordering assumption awaiting user clarification: needs a load soonest, rather
than a manually saved personal Route Me job order. No operational records changed.
