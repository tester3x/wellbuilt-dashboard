# Operation / data matrix (16g, source review)

This is the intended policy. Rules, callables, and clients must agree.
**Not deploy-ready.** Do not deploy these rules while required WB-T / Dashboard
/ JSA client migrations remain incomplete. 16f is do-not-redistribute.

`token.role` is not used. Company staff live in Firestore `staff/{uid}`
(role + companyId) or RTDB `users/{uid}/role` for Dashboard/RTDB only.

## Classification

| Dataset | Class | Driver | Company staff | Platform admin | Client write |
|---|---|---|---|---|---|
| invoices / tickets / dispatches | tenant + owner | owner read via callable/rules | same company | all | **none** (callable) |
| jsas / jsa_day_status | tenant + owner | owner | same company | all | owner create/update only |
| chat_threads / messages | tenant + members | participant | same company | all | **none** (callable) |
| packets/processed, outgoing | tenant | company query | RTDB role | all | **none** (callable) |
| well_config / wells | tenant if `companyId` present | same company only | RTDB admin/it/manager | all | **none** |
| status / production / performance | operational, staff | deny | RTDB role | all | **none** |
| driver_pulls | owner | self | staff | all | **none** |
| devices | owner | self uid | admin/it | all | **none** |
| incoming_version | notification counter | signed-in driver/staff | staff | all | **none** |
| job_packages / app_registry | global catalog | read | read | read | **none** |
| jsa_templates/{companyId} | tenant | same company | dashboard | all | **none** |
| photo_requirements | staff catalog | deny (callable later) | dashboard | all | dashboard |
| customLocations | tenant | same company | dashboard | all | **none** |
| unmatched* | sensitive | deny | deny | deny | **none** |
| driver_credentials / name index | secret | deny | deny | deny | **none** |
| platform_admins / staff | authority | self read | self read | CF write | **none** |
| storage objects | tenant + owner | own prefix via signed URL | not via Storage rules | claim only | signed URL only |
| jsa_read_receipts | **public create** | unauth create, bounded | — | — | bounded create |
| daps_waitlist | **public create** | unauth create, bounded | — | — | bounded create |

## Public create remaining abuse (not hidden)

`jsa_read_receipts` and `daps_waitlist` remain unauthenticated creates for
compatibility. Rules now bound keys, field lengths, and enums. There is
**no request-rate limit in rules**. Remaining exposure: many small bounded
creates. Replacement is an authenticated rate-limited callable.

## WB-T writers

Invoice/ticket/dispatch/chat/transfer/outbox client writers are **incomplete
replacements**. Rules stay undeployed until they are callable-only and
emulator-tested on the same app instance.
