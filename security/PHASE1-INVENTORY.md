# Phase 1 — Exposure & Dependency Inventory

**Project:** `wellbuilt-sync`
**Evidence backup:** `D:\dev\_forensic_backups\wellbuilt-sync-security-20260731-201322`
**Branch:** `security/database-containment`
**Date:** 2026-07-31

## Pre-change snapshots preserved

| Artifact | Path under backup |
|----------|-------------------|
| RTDB rules | `rules/database.rules.json` (global `.read`/`.write` true) |
| Firestore rules | `rules/firestore.rules` |
| Storage rules | `rules/storage.rules` (global open) |
| `drivers` tree | `rtdb/drivers.json` |
| Suspicious pending A/B | `rtdb/pending-suspicious-A.json`, `…-B.json` |
| Auth users | `auth/auth-users.json` |
| Functions list | `meta/functions-list.txt` |
| Dashboard HEAD | `meta/dashboard-git-HEAD.txt` |

## Confirmed exposure

| Finding | Evidence |
|---------|----------|
| RTDB anonymous root read/write | Live unauth GET 200; rules `.read`/`.write: true` |
| Storage anonymous read/write | `storage.rules` allow all |
| Firestore many open writes | `invoices`, `tickets`, `companies`, `chat_*`, `jsas`, etc. `if true` |
| Passcode hashes world-readable | `drivers/approved` shallow + full export |
| Client REST uses API key as `?auth=` | Suite/WB-T/WB-M/JSA/eWallet — **not** Firebase Auth |
| JSA client self-approves | `JSA/services/driverAuth.ts` `registerStandalone` PATCHes `drivers/approved` |

## Confirmed unauthorized records

| Record | Notes |
|--------|-------|
| `drivers/pending/-OypyveashNe-jvJ1C52` | `wprjjg` / `ewlwqh` / `qfabrv`, source `wbs`, 2026-07-31T02:23:19.688Z |
| `drivers/pending/-OysC-aQ4uyQSWIW7jY1` | same fields, different passcodeHash, 2026-07-31T12:44:04.017Z |
| Neither in `drivers/approved` | Not approved via workflow |

**Do not delete these.** Mike may mark `status: rejected` after backup (already backed up).

## Confirmed unauthorized access

| Item | Status |
|------|--------|
| App-level login for suspicious names | **No** — hashes not in approved |
| World-readable RTDB | **Yes** — any client with public API key / URL |
| World-writable RTDB (capability) | **Yes** — rules permit; **no per-request proof** of third-party writes beyond the two pendings |

## Cannot be determined (missing logs)

- Whether anyone besides Mike’s team read packets/users/photos
- IP / UA of the two pending POSTs
- Whether anyone self-approved a driver via direct write
- Historical App Check (none enforced)

## Passcode hash offline risk

**Construction:** `SHA-256( lowercase(trim(displayName)) + passcode )` (client, no salt).

| Property | Impact |
|----------|--------|
| Fast hash (SHA-256) | GPU/CPU offline brute-force trivial |
| No salt / no pepper | Same name+passcode → same hash; rainbow tables possible |
| Hash is RTDB **key** and **public** | Attacker enumerates all keys + displayNames |
| Short numeric passcodes (common for drivers) | 4-digit PIN ≈ 10k tries; 6-digit ≈ 1M — seconds |

**Conclusion:** Treat all existing approved hashes as **compromised**. Do **not** migrate them as login material into the secured system. Legitimate users must **set a new passcode** via admin-assisted reset or re-registration after server-side scrypt storage.

## Active approved identities (pre-migration, names only)

From live export (10 approved): iPhone16, ABurger (inactive), AcmeMike, Test Auth, Marcial Lebaron, AdanS, TabletS10, Wisho-135, MikeS24, Mikezfold — mostly Liquid Gold + Acme.

## Per-app direct access summary

| App | Direct RTDB | Direct Firestore | Direct Storage | Self-approve |
|-----|-------------|------------------|----------------|--------------|
| Suite | Yes | Yes (REST) | No core | No |
| WB-T / Metro | Yes | Yes (heavy) | Yes photos | No |
| WB-M / delivery | Yes (packets) | app_registry | No | No |
| JSA | Yes | Yes | JSA PDFs | **Yes** |
| eWallet | Yes auth | Partial + CF | CF preferred | No |
| wellbuilt-ewallet | Yes | Yes legacy docs | Yes | No |
| Dashboard | Yes Auth SDK | Yes | Yes | Admin UI writes approved |
| Cloud Functions | Admin SDK | Admin SDK | Admin SDK | N/A |

Full path table: see exploration output stored in session; key paths listed in `MIGRATION-MATRIX.md`.
