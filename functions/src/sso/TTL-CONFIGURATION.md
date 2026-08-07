# SSO authorization-code cleanup — TTL configuration (NOT APPLIED)

**Status: documented only. No TTL policy is configured, and nothing
deletes expired records today.**

## What already protects you

Expired records are **already unusable**, independent of cleanup. The
consume transaction in `ssoExchangeHandler.ts` rejects on server time:

```ts
if (deps.nowMs() >= record.expiresAtMs) return { ok: false, reason: 'expired' };
```

That check runs before any binding is accepted, uses the **server** clock,
and is proven by test (`expired code rejected by SERVER time`, and
`expired code was NOT consumed`). Cleanup is therefore a storage-hygiene
concern, not a security control — a record that outlives its TTL policy
by a week is still dead.

## The field

`sso_authorization_codes/{sha256(code)}` carries two expiry values:

| Field | Type | Owner | Used by |
|---|---|---|---|
| `expiresAtMs` | number | server | protocol validation in the consume transaction |
| `expiresAt` | Firestore `Timestamp` | server | the TTL policy below |

Both are computed from `deps.nowMs()` at issuance. **The client supplies
neither**, and cannot: the issuance request schema has exactly four
fields (`protocolVersion`, `audience`, `codeChallenge`,
`codeChallengeMethod`) and any identity or timing field in the request
body is a hard reject.

Two fields rather than one on purpose. Protocol validation keeps using
the numeric value so correctness never depends on a policy that is not
configured; `expiresAt` exists solely so Firestore's native TTL can read
it.

## The configuration to apply later — DO NOT RUN NOW

Firestore TTL is project configuration, not code, and applying it is out
of scope for this work.

- **Collection group:** `sso_authorization_codes`
- **TTL field:** `expiresAt`

```
gcloud firestore fields ttls update expiresAt \
  --collection-group=sso_authorization_codes \
  --enable-ttl \
  --project=wellbuilt-sync
```

Notes for whoever applies it:

- Firestore deletes within ~24h of the timestamp, not at it. That is fine
  here precisely because expiry is enforced in the transaction.
- A TTL policy creates a single-field index exemption; check the existing
  index configuration before enabling.
- Deletion is billed as a normal delete operation.
- Verify with `gcloud firestore fields ttls list --project=wellbuilt-sync`.

## Why no scheduled cleanup Function

Adding another exported, deployable Function is a change to the
deployment surface, and this repository's convention is that such
additions are reviewed on their own. Native TTL needs no Function at all.
If a scheduler is ever preferred over native TTL, that decision should be
raised and approved before the code is written — not discovered in a
diff.

## What is pinned in tests

- the stored record carries `expiresAt` alongside `expiresAtMs`
- `expiresAt` mirrors `expiresAtMs` exactly
- `expiresAt` is produced by a server-owned dependency the client cannot reach
- an expired record is rejected **whether or not** cleanup has ever run
- an expired record is **not** consumed by the rejected attempt
