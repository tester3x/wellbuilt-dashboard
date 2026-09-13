# Emulator regression — RTDB users/{uid} writability (read-only proof; no production)

Harness: docs/authz-evidence/emulator-harness/ (probe.mjs + firebase.json). Copy the
rules file under test to `rules.json` beside firebase.json, then:
  set JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:\t
  firebase emulators:exec --only database --project wellbuilt-sync "node probe.mjs"
probe.mjs authenticates as an ORDINARY user (unsigned JWT, uid=attacker, NO
wellbuiltAdmin/platformAdmin/staff claims) and attempts PUT users/attacker/companyId
and users/attacker/roles.

RUN A — DEPLOYED rtdb rules (docs/authz-evidence/DEPLOYED-rtdb-rules.json, fetched live):
  WRITE users/attacker/companyId => 401 DENIED (Permission denied)
  WRITE users/attacker/roles      => 401 DENIED (Permission denied)

RUN B — STALE repo database.rules.json (firebase.json deploy target, NOT what is deployed):
  WRITE users/attacker/companyId => 200 ALLOWED
  WRITE users/attacker/roles      => 200 ALLOWED

Conclusion: the DEPLOYED rules block the forge prerequisite; the repo deploy-target
file would open it if ever deployed from this repo.
