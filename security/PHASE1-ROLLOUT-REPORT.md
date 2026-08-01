# Phase 1 Rollout Report — Admin UI hosting + security client builds

**Date:** 2026-08-01  
**Project:** wellbuilt-sync  
**Stop line honored:** No client installation, no tester distribution, no passcode reset, no App Check enforcement, no secure rules deploy, no vc33 APK replacement.

---

## 1. Dashboard hosting deployed commit / revision and smoke-test

| Item | Value |
|------|--------|
| Source branch | `security/database-containment` |
| Source commit | **`a5d65c6`** (`a5d65c61088563f703ea91442cd16883f076ef67`) |
| Deploy command | `firebase deploy --only hosting --project wellbuilt-sync` |
| Hosting site | `wellbuilt-sync` → https://wellbuilt-sync.web.app |
| Hosting version | `projects/wellbuilt-sync/sites/wellbuilt-sync/versions/5f38dc5e81c47b9c` |
| Deploy time | 2026-08-01T04:36:04Z (finalize ~04:36:08Z) |
| Rules / functions | **Not deployed** |

### Predeploy

- Security emulator suite: **PASS** (`run-all-predeploy.mjs` exit 0)
- Passcode unit tests: **PASS**
- `next build` static export: **PASS** (24 routes)

### Smoke (no passcode mutations)

| Check | Result |
|-------|--------|
| `/` 200 | PASS |
| `/admin/` 200 | PASS |
| `/login/` 200 | PASS |
| RTDB anonymous still open | **200** (dual-run intact) |
| `getPublicClientMeta` | `appCheckEnforced=false`, `secureAuthRequired=false` |
| `adminListPendingRegistrations` unauth | **401** |
| Secure Admin callables wired in DriversTab | approve / reject dual-run; `secureDriverAdmin` helpers present |
| Legitimate passcode reset | **Not performed** |

---

## 2. Complete Android / iOS build matrix

| Product | Repo | Platform | Package / Bundle | EAS project | Installed (S24) | New build | Profile | Signing | Distribution | Data-preserving update? |
|---------|------|----------|------------------|-------------|-----------------|-----------|---------|---------|--------------|-------------------------|
| WellBuilt Tickets (WB-T) | WB-T | Android | `com.testerxxx.waterticket` | `@testerxxx/waterticket` (`4827a6d8-…`) | **vc 33** (vc33 APK) | **vc 35** | preview APK | EAS keystore `v0RPWsynRr` | Internal APK URL | **Yes** (same package, higher vc) |
| WellBuilt Tickets | WB-T | iOS | `com.wellbuilt.tickets` | same | n/a on S24 | buildNumber **15** | preview | Ad Hoc cert + profile (iPhone UDID present) | **FAILED** Xcode sign | n/a |
| WellBuilt Suite | Suite | Android | `com.wellbuilt.suite` | `@testerxxx/wellbuilt-suite` | **vc 5** | **vc 6** | preview APK | EAS keystore `y2FLQctyJ5` | Internal APK | **Yes** |
| WellBuilt Suite | Suite | iOS | `com.wellbuilt.suite` | same | unknown | — | preview | **Blocked** (no internal dist credentials in non-interactive) | — | — |
| WellBuilt Mobile (WB-M) | WB-M | Android | `com.wellbuiltmobile.app` | `@testerxxx/WellBuiltMobile` | **vc 5** | **vc 6** | preview APK | EAS keystore `zi3_EOb90I` | Internal APK | **Yes** |
| WellBuilt Mobile | WB-M | iOS | `com.wellbuiltmobile.app` | same | prior TF bn73 | **bn 74** | production (no submit) | Dist cert + PP active thru 2026-11-25 | Internal IPA URL | **Yes** (TestFlight/internal) |
| WellBuilt JSA | JSA | Android | `com.syconik801.jsaapp` | `@testerxxx/jsa-app` | **vc 1** | **vc 2** | preview APK | EAS keystore `6Dj7kFOiJh` | Internal APK | **Yes** |
| WellBuilt JSA | JSA | iOS | `com.wellbuilt.jsa` | same | unknown | — | preview | **Blocked** (no internal dist credentials) | — | — |
| WellBuilt eQuipment | eWallet security @ `ac02474` | Android | config = `com.wellbuilt.ewallet` | `@testerxxx` ewallet project | **Installed is `com.wellbuilt.equipment` vc1** | **BLOCKED** | — | — | — | Would create **second** app if built as ewallet package |
| Dashboard | dashboard | Web | Hosting | Firebase | live | **deployed** | hosting only | n/a | https://wellbuilt-sync.web.app | n/a |

### eQuipment package resolution (blocker)

| Fact | Value |
|------|--------|
| Active product name on device | WellBuilt eQuipment |
| Installed package (S24 adb) | **`com.wellbuilt.equipment`** versionCode **1** |
| Security branch repo `D:\dev\eWallet` | name “WB eQuipment”, package **`com.wellbuilt.ewallet`**, HEAD `ac02474` |
| Sibling repo `wellbuilt-ewallet` → remote `wellbuilt-equipment` | package **`com.wellbuilt.equipment`**, branch `wb-equipment/dvir-integration` @ `eb25872`, **no security dual-run** |
| Decision | **Do not build** security APK from ewallet package (wrong app identity). Port security to equipment package or reconcile package ID before Phase 2. |

### iPhone16 / TestFlight scope

| App | iOS identity | Credentials | This phase |
|-----|--------------|-------------|------------|
| WB-M | `com.wellbuiltmobile.app` | Valid (Team 93VB7DY33R) | **IPA produced** bn74 |
| WB-T | `com.wellbuilt.tickets` | Ad Hoc profile includes iPhone UDID `00008140-001664340EE1801C` | Build **ERRORED** (Xcode signature-collection) |
| Suite | `com.wellbuilt.suite` | Missing internal-distribution credentials non-interactive | **Blocked** |
| JSA | `com.wellbuilt.jsa` | Missing internal-distribution credentials | **Blocked** |
| eQuipment | `com.wellbuilt.ewallet` / equipment | Not built | **Blocked** (Android package first) |

No App Store submission performed.

---

## 3. Exact builds successfully produced

| Product | Platform | versionCode / buildNumber | EAS build ID | Source commit | Artifact |
|---------|----------|---------------------------|--------------|---------------|----------|
| Suite | Android | **6** | `2f0adc6f-bf8a-487f-92ec-2f27e226fc75` | `9e38943` | [APK](https://expo.dev/artifacts/eas/WGvu3_rHcsYU1i94GhVjbbKAPrmQI9PT_kOxzAkbmbM.apk) |
| WB-T | Android | **35** | `00cb762b-d0e8-405f-b324-4f0279068f77` | `bfecef9` | [APK](https://expo.dev/artifacts/eas/o0J1v4Guvlj94GqocCfX0KDhxVMjt8ScAgh3-VBhhKA.apk) |
| WB-M | Android | **6** | `31f78295-d239-47c3-8cf5-beeaceb62052` | `0ea1011` | [APK](https://expo.dev/artifacts/eas/q3Y8bEFDBUadBbT38kfuHunPATwkgtKcQoOO7yXuv4o.apk) |
| WB-M | iOS | **74** | `90b22e73-4153-4002-a7e0-0b79ceba6dc3` | `d9bedb5` | [IPA](https://expo.dev/artifacts/eas/h2AZtAOYi58XLgXvEUgKI6-vqGGGYRbFEfx16vyMzG0.ipa) |
| JSA | Android | **2** | `03e52ef3-433f-4814-92a7-ead7e5040eb3` | `efbef28` | [APK](https://expo.dev/artifacts/eas/L1rtAIJoh-TOaizeMDpKso26sLs_mDUV03SX0HFTuNg.apk) |

### Local artifact copies + SHA256

Directory: `D:\dev\_forensic_backups\phase1-artifacts\`

| File | Size (bytes) | SHA256 |
|------|--------------|--------|
| Suite-android-vc6.apk | 79,950,178 | `680E9CD7F2FB5668C3C45ECB7CF5F8AB5C2350C21E504F03B7B4B93FF2E9BE1A` |
| WBT-android-vc35.apk | 129,827,845 | `E6D25385F6227E73B86D9A55874E9EE37A54A6DFF885989BFF2FC557AEE5D649` |
| WBM-android-vc6.apk | 92,704,646 | `1713C1C02D0585873F176CF01DBDE52134C97A6A4B1B3153A367662019AB7BCD` |
| WBM-ios-bn74.ipa | 20,185,975 | `8E0EC4B39507ADE7485EECB8282DD8522C5B078D14F93D856AB6CC28CBBD5B3F` |
| JSA-android-vc2.apk | 88,411,155 | `1642C2D93B81F299707022196B068819935651C695E0783A5ED8FC1C1DCF23E5` |
| WBT-android-vc33-PRIOR.apk | 129,820,429 | `F5380D0E3D6AF105A2C00DDCA23572CE82DF352CF28D7ED2DB3B7358676A5990` |

---

## 4. Apps / platforms blocked

| Item | Blocker |
|------|---------|
| **eQuipment Android security APK** | Security HEAD package `com.wellbuilt.ewallet` ≠ installed `com.wellbuilt.equipment` — building would create a second app |
| **Suite iOS** | Non-interactive EAS: no suitable internal-distribution credentials |
| **JSA iOS** | Same credential blocker |
| **WB-T iOS** | EAS build `73e5b8c1…` **ERRORED**: Xcode `signature-collection failed` (SWBUtil.CodeSignatureInfo) |
| **Fold / tablet** | Not connected this session; only S24 (`R5CX15HEGQB` SM_S928U) queried via adb |

---

## 5. WB-T vc33 ancestry / parity proof

| Check | Result |
|-------|--------|
| Ancestor `34feb11277a84f4f6887de433e9e3f27aee8ab15` | **YES** (`merge-base --is-ancestor` exit 0) |
| Security-only commits above vc33 | `a196346`, `d01a961`, `21ea52e`, `e7b69a5`, + build-only `bfecef9` (.easignore) |
| Diff vs vc33 | **Only** security dual-run files: `secureDriverAuth`, `secureOperationalApi`, `appCheckInit`, `driverAuth`, dual-run hooks in `firebase.ts` / `dispatchService` / `chatService` |
| Unchanged nine-fix cores | `useInvoiceLifecycle`, `jsaCloseCoverage*`, `safeOutbox`, `photoDelivery`, `TicketModule` — **no diff** |
| `diag/first-photo-lifecycle` | **Not edited / not built** |
| Critical suites | 14/14 PASS (outbox, JSA close gates, photo, identity) |
| versionCode | Installed **33**; security APK **35** (remote autoIncrement: failed 2GB attempt consumed 34) |

**Build-only correction (reported):**  
`.easignore` committed as `bfecef9` so EAS upload stayed under 2GB (excluded local `.android-sdk`, `.tmp-apk`, etc.). No app behavior change.

---

## 6. Artifact package / version / source verification

| Build | Package (config / native) | version | Source | Profile |
|-------|---------------------------|---------|--------|---------|
| Suite Android | `com.wellbuilt.suite` | 1.0.0 (6) | `9e38943` security | preview |
| WB-T Android | `com.testerxxx.waterticket` (native android dir) | 1.0.0 (35) | `bfecef9` = e7b69a5 + easignore | preview |
| WB-M Android | `com.wellbuiltmobile.app` | 2.1.0 (6) | `0ea1011` = d9bedb5 + eas autoIncrement | preview |
| WB-M iOS | `com.wellbuiltmobile.app` | 2.1.0 (74) | `d9bedb5` | production (no submit) |
| JSA Android | `com.syconik801.jsaapp` | 1.0.0 (2) | `efbef28` = 233ae4e + eas autoIncrement | preview |

Same-package updates: Android update installs preserve app data (no uninstall). Downgrades (e.g. 35→33) typically require uninstall on Android → **not acceptable** for data-preserving rollback.

---

## 7. iPhone / TestFlight update availability

| App | Status |
|-----|--------|
| WB-M iOS bn74 | **IPA ready** — internal/production profile; **not submitted** to App Store; not promoted; testers not invited |
| WB-T iOS | Failed build — fix signing/Xcode before iPhone security cutover |
| Suite / JSA iOS | Need interactive credential setup |
| Provisioned iPhone | UDID `00008140-001664340EE1801C` on WB-T Ad Hoc profile (credentials present; build still failed at signature-collection) |

---

## 8. Current legitimate tester / device mapping (this session)

| Device | Identity | Observed packages |
|--------|----------|-------------------|
| Mike S24 | `R5CX15HEGQB` / SM_S928U | WB-T **vc33** `com.testerxxx.waterticket`; Suite vc5; WB-M vc5; JSA vc1; eQuipment **`com.wellbuilt.equipment` vc1** |
| Fold / tablet | Not adb-connected | Unknown this phase |
| iPhone16 | Profile exists on WB-T | Install set not verified on-device this phase |

**vc33 remains installed on S24 — not replaced.**

---

## 9. Ready for controlled installation?

| Client | Ready? |
|--------|--------|
| Dashboard Admin UI | **Yes** (already live) |
| Suite Android | **Yes** (artifact ready; not installed) |
| WB-T Android | **Yes** (artifact ready; **wait for Mike vc33 home test complete**) |
| WB-M Android | **Yes** |
| WB-M iOS | **Yes** (IPA; internal only) |
| JSA Android | **Yes** |
| eQuipment | **No** — package identity blocker |
| Suite/JSA/WB-T iOS | **No** — credentials or build failure |

**Not all clients ready** for a single coordinated install wave until eQuipment package is resolved and iOS blockers addressed (WB-T iOS at least if iPhone is in-scope).

---

## 10. Recommended installation order (next phase only)

1. Dashboard already live — use for admin ops  
2. Suite Android  
3. WB-T Android **only after Mike finishes vc33 home testing**  
4. WB-M Android  
5. JSA Android  
6. WB-M iOS internal/TestFlight when iPhone soak needed  
7. eQuipment **after package reconciliation**  
8. Remaining iOS after credentials  

---

## 11. Recommended credential-migration order (later)

1. Admin UI: approve pending via secure path; assign **temporary** passcodes for pilot drivers only  
2. Suite login first (identity hub)  
3. Field apps (WB-T → WB-M → JSA → eQuipment)  
4. Do **not** bulk-reset legitimate testers during Phase 1  
5. Force first-change on temp passcodes only  

---

## 12. Rollback plan

| Layer | Action |
|-------|--------|
| **Server** | Prefer compatibility: keep dual-run, open rules, custom-token identity callables; set no App Check enforce; do not deploy secure rules |
| **Dashboard hosting** | Redeploy prior hosting version if needed (previous: `51b74665e8a91d09` from 2026-07-27) |
| **WB-T client** | Keep vc33 APK preserved: EAS `6b9eb748…` + local `WBT-android-vc33-PRIOR.apk` SHA256 `F5380D0E…`. Reinstall **same package** only if forced; **downgrade may wipe data** — prefer leaving vc33 installed until security proven |
| **Other Android** | Prior EAS builds remain on Expo; avoid uninstall |
| **Unacceptable** | Uninstall-to-downgrade that clears offline queues / AsyncStorage |

---

## 13. Disposable production records

- None created during Phase 1 hosting smoke (read-only / unauth rejection only).  
- Prior security-phase disposables cleaned in earlier checkpoint.

---

## 14–16. Confirmations

| Statement | Status |
|-----------|--------|
| 14. No legitimate passcodes reset | **Confirmed** |
| 15. No client installed or distributed to testers | **Confirmed** (S24 still WB-T vc33) |
| 16. App Check enforcement off; production rules open | **Confirmed** (`appCheckEnforced=false`, RTDB 200) |

---

## Security branch HEADs after Phase 1 build-only commits

| Repo | Expected pre-phase | Actual end of Phase 1 |
|------|--------------------|------------------------|
| dashboard | `a5d65c6` | **`a5d65c6`** (unchanged) |
| WB-T | `e7b69a5` | **`bfecef9`** (+ `.easignore` build-only) |
| eWallet | `ac02474` | **`ac02474`** (not built) |
| Suite | `9e38943` | **`9e38943`** |
| WB-M | `d9bedb5` | **`0ea1011`** (+ preview autoIncrement/APK) |
| JSA | `233ae4e` | **`efbef28`** (+ preview autoIncrement) |

---

## Stop

**Phase 1 complete for Mike review.**  
Do not install builds, distribute to testers, reset credentials, enforce App Check, disable legacy fallback, or deploy secure rules until authorized.
