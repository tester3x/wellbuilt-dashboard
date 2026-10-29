# Governed pull delete connection failures

Merged the current approved Dashboard source before this correction; previous laptop release notes remain preserved. An unrelated untracked app.json was moved intact to a private preservation path outside the build input.

Firebase callable errors use functions/ prefixes and authentication failures may use auth/. The old delete mapper recognized only unprefixed codes, hiding permission, expired-session and network failures behind one generic error. It also asserted unchanged data on unknown/timeout results, even though a response may be lost after a server commit. Normalize those known SDK prefixes and ask the user to refresh/confirm an uncertain outcome before retrying. Server authorization, identity validation, deterministic delete key and canonical processor remain unchanged; no security/rules deployment.

The explicitly requested wrong-well latest zero-barrel packet was independently identified and backed up privately, then submitted once through the existing deterministic incoming delete processor. Canonical completion and previous surviving history were checked; no other well records were changed. Account capability and deployed authorization policy permit the operation, and the function is reachable. No corresponding call reached it for the reported failed attempt, so a server permission denial was not observed. The exact original browser exception was not captured; connectivity/session failure cannot be distinguished retrospectively. Do not claim a proven cell outage.

Regression exercises real prefixed permission/session/network errors, browser fetch failure, sanitized server reasons, uncertain outcomes and no implicit duplicate retry.
