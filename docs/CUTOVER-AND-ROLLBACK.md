# Cutover and rollback (source review — not an authorization to deploy)

This document must **not** be read as “rules deployment is the next step.”

See `docs/OPERATION-MATRIX.md`. Required WB-T invoice/ticket/dispatch/chat/transfer/outbox writers are still incomplete or untested against closed rules. **Do not deploy Firestore, RTDB, or Storage rules, and do not ship a secure-only Class-2 client, until:**

1. Every operational callable listed in `operational/index.ts` is proven with Auth emulator tests.
2. WB-T uses the same Firebase app instance for Auth and Firestore and has no unauthenticated fallbacks.
3. `ALLOW_LEGACY_LOGIN_MIGRATION` is separately authorized **before** Class-2 testers receive a secure-only build.
4. The well_config companyId preflight (see `WELL-CONFIG-COMPANY-PREFLIGHT.md`) is authorized and completed.

Rollback of a future closed-rules deploy must **not** restore root-public RTDB/Storage rules.

No production action is authorized by this packet.
