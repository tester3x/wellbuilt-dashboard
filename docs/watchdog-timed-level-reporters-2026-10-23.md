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
