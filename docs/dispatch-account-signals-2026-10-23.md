# Dispatch account signals

staffGetDispatchDriverSignals is a read-only, bounded canonical-driver batch for
the Dashboard's suggested-driver selector. It requires verified platform admin
authority or the selected company's trusted viewDispatch capability. Profile
company containment is checked before reading identity proofs; unknown/foreign
profiles return unknown without exposing their activity. No credential/profile
payload or arbitrary legacy alias is returned.

The projection uses only identity-matched secure login and own-profile hydration
timestamps, plus canonical profile sign-out timestamps. A recent authenticated
check is recently_active, a newer sign-out is signed_out, and stale/missing or
invalid/future proof is unknown. Activity older than thirty minutes is not
misreported as signed out. Shift and job state are never sign-in evidence.

Three focused tests verify projection/time ordering, staff scope, containment,
bounded IDs and no credential leakage. Functions TypeScript build passes.
No client tracking, auth mutation, GPS writer, security rules or phone build is
included. Dashboard runtime changes are held in the guarded release lane.

The single callable deployed from `85b0ddb2` and is ACTIVE as revision
staffgetdispatchdriversignals-00001-tej. Live verification at 15:38 UTC confirms
signed-out access returns 401 / Sign in required. The real canonical account
evidence projection was checked privately, without creating or changing any
account, shift, dispatch or invoice records. Dashboard runtime source
`983c2ae4` is deployed with all 362 live artifacts byte-verified.
