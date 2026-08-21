# Read-only well_config companyId preflight (not executed)

**Status:** separately authorized later. This packet does **not** probe production.

`submitFieldCommand` fail-closes when `well_config/{well}/companyId` is missing. Before any rules/functions deploy, an authorized operator should run a **read-only** inventory:

1. List `well_config` keys.
2. Count wells with a nonempty `companyId`.
3. Count wells missing `companyId`.
4. Do not write, backfill, or guess company IDs from the client.

No production login or Admin SDK probe is authorized in this source-review packet.
