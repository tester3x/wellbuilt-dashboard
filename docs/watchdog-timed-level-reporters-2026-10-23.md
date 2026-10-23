# Timed level reports — October 23, 2026

The parser now accepts a leading `level`/`levels` label and an `@` immediately
before the stated time. A trailing note does not displace the first gauge. The
same parsing applies to every configured well; it is not a one-ticket template.
Level-only observations retain zero removal and their actual stated time.

An optional `channel.timedLevelReporters[senderHash]` rule permits a specifically
enabled reporter with `startAt` to submit a stated-time level observation without
owning a canonical driver account. It does not bind that reporter to a driver,
grant other well access, infer barrels, infer a missing measurement time, alter
well-down state, or admit administrative multiwell gauge lists. Existing bound
driver behavior remains in place. Reporter provenance distinguishes this scoped
report from verified driver ownership; existing flow-window protections remain.

Validation: 93 parser/import/model/ownership/flow-window tests passed, plus three
targeted signed-intake tests covering the existing driver gate, administrative
batch exclusion, and the new scoped reporter path. Functions TypeScript build
passed. A private replay of the owner's actual message parsed a single zero-volume
observation with the stated gauge and time. Simulation of possible withdrawals
was read-only; simulated loads must never be inserted into operational history.

Runtime installation and live receipt verification are separate from this source
checkpoint and will be recorded after they complete. No Hosting, app build,
security-rule or canonical packet-processor deployment is part of this patch.

Intake source **08f6bca0751c4b0bc3e172a95b83a6edae5ac5b1** was deployed to
`dashboard:ingestWatchdogPullV2` only. The owner-confirmed original gauge message
was submitted with the HP's existing scoped HMAC transport. At
2026-10-23T05:37:22.819Z, its exact stated time, gauge, zero volume and canonical
completion were verified in WB M. No simulated withdrawal was written. The
reporter policy is limited to one exact captured sender and the existing two-well
channel; no canonical driver binding or other well permission was added.

## Receiver recovery checkpoint

The HP source fast-forwarded from b53a69c6 to 08f6bca0, preserving its untracked
operational helpers. Compiling on the HP caused contention; those two build
processes were stopped and the locally built/tested parser installed instead.
The persistent queue and linked session were retained, with a queue backup.

The canonical startup script now reuses a saved bridge configuration, checks its
loopback listener with a bounded socket operation, anchors an installed script to
its adjacent persistent queue, and connects/resumes an existing stopped receiver.
A regression executes the actual script with a fixture listener and mocked APIs,
proving connect/resume without duplicate process launch or repeated discovery.
The task wrapper uses noninteractive PowerShell and captures startup errors;
task principal/triggers and the original task XML are preserved. Browser startup
stages log only phase names, without message content or credentials.

These startup changes are a **recovery checkpoint, not yet an automatic-delivery
pass**: the scheduled desktop process has stalled, and WhatsApp watching must be
verified connected and unpaused before the task is called complete. A direct
submission of the already-captured gauge does not establish receiver health.
