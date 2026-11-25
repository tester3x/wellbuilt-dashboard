# Watchdog reconciliation — November 25, 2026

Owner authorized checking both home workers and recording confirmed missing loads once. All checks and operational evidence are retained privately under C:/dev/release-artifacts; credentials, raw chats, original photos and tokens are excluded from Git. No worker code deployment or historical bulk replay occurred.

Both ROG main and HP backup were Connected, unpaused and capture-healthy, with current Firebase reports. Ten recent completed source messages each matched one delivery ledger entry and one WB Mobile processed packet. The two explicitly confirmed missing Dwyer messages were then reconciled individually.

| Source message | Local date/time (Central) | Confirmed bottom | Barrels | Final packet | Verification |
| --- | --- | --- | --- | --- | --- |
| AC820C7A2FB8932E91BDD551FC4097B4 | Nov. 25, 8:04:49 AM | 6.2 ft | 140 | 20261125_140449_Dwyer_4a50b7 | One message ledger entry and one processed packet; actual canonical measurements checked |
| ACA03C86EF51D10A9DE050688550C017 | Nov. 23, 6:54:48 PM | 8.1 ft | 140 | 20261124_005448_Dwyer_e2c39e | One message ledger entry and one historical processed packet; owner correction completed and verified |

The Nov. 23 source is stored as Nov. 24 at00:54:48 UTC. Original synced WhatsApp metadata confirms that conversion. It must not be treated as a second day's load just because its UTC date differs.

The older photo was initially confirmed by Mike as7.3 ft, then corrected to8.1 before reconciliation finished. The first intake was rejected by the stale-time guard and did not update the current gauge. Recovery used the existing owned historical-resolution path. A canonical same-packet edit then applied the revised8.1 reading. The correction outbox completed; the processed packet, receipt and review projection agree on8.1. Original review/result values and the owner-correction audit were retained.

After recovery and correction, Dwyer's current lastPull still referenced today's8:04 AM packet, at6.2 ft and140 bbl, with its original timestamp and bottom inches unchanged. No current gauge or newer pull was replaced by the older record.

The matching Nov. 23 hold was dismissed as already recorded on both workers through their existing local review endpoint. The HP automatically adopted today's completed Dwyer receipt. Its stale Nov. 20 Kahuna hold for message3AC307FAF60DC753AC5A was dismissed only after verifying its exact message hash, one receipt, one processed packet and the prior owner-authorized historical resolution. No second load was sent.

Remaining old ambiguous reviews were retained. The Nov. 16 provisional Kahuna barrel estimate was left unchanged. HP's Rennerfelt1 payload-conflict retry already has one matching ledger/processed packet; it was not resent or raw-edited, and its retry disposition remains a follow-up. Absence from the current V2 message ledger alone does not prove an old/manual load is missing, so those older ambiguous observations were not backfilled.

Evidence:

- watchdog-quick-20261125-workers.json: main/backup health and role readback.
- watchdog-quick-20261125-cloud.json: ten recent completed-message checks plus the newly held photo.
- watchdog-all-holds-cloud-20261125.json: exact message-hash comparisons, including both final Dwyer packet counts at1.
- watchdog-dwyer-two-cleanup-20261125.json: actual final8.1/6.2 measurements and preserved latest lastPull.
- dwyer-20261123-185448-owner-recovery.json and owner-correction-completed.json: recovery and verified same-packet correction audit.
- watchdog-old-hold-cleanup-20261125.json and watchdog-20261125-cleared-hp-holds.json: bounded local review dispositions.
