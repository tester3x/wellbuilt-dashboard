# Dispatch location search recovery — 2026-10-05

Dashboard branch: `release/dashboard-reassignment-20261005`.

- Hosting source `328e8ac1`: built through the certified preflight, deployed, and all 20 Dispatch HTML/static assets byte-matched live at 2026-10-05T18:59:36Z.
- New read-only Function `getDispatchLocationCatalog` deployed independently from source `2477e56e`. No other Functions, authentication claims, or rules deployed.
- Company staff are authorized by the server-owned company authority and `viewDispatch`; platform admins require the verified admin claim plus enabled platform record. The selected company controls the server-owned assigned operator list. Driver callable authentication remains unchanged.
- Live authenticated verification: Liquid Gold selection persisted after reload; Mauser results appeared for both pickup and drop-off, and pickup returned results for the two-character query `ma`. WELL badge and operator/county secondary line rendered correctly. No catalog error remained.
- Shared result rendering and combined catalog are used in Dispatch create/project/completed-job/destination searches. WB-M monitoring remains separate from the full job catalog.
- Five new server authorization tests pass; Dashboard library checks pass (380 native-run tests plus seven service-work tests rerun with the compatible TS loader; one existing skip). All mandatory Hosting UI guardrails pass.

WB-T branch `codex/wbt-current-20261004`, pushed checkpoint `c1099d1`: pickup search handler and autocomplete display gate both changed from three to two characters, matching drop-off. Source-only; no WB-T build or installation for this change.

Remaining work: the header company selection is shared with Settings and Dispatch catalog loading. It has not yet been connected to every other Dashboard tab or every Dispatch operational data subscription/write. Do not describe it as complete suite-wide company scoping. Company SWD directory aliases/blacklists should also be reconciled with the job catalog for full WB-T parity.
