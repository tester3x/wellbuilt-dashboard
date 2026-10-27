# Fresh Water Tank Refill contract

This is a single-load, hourly service job for filling the fresh-water tanks on a producing well pad. It is distinct from the existing `Fresh Water` service type used for frac tanks and hot oilers. It reuses the `water-hauling` packet and the pad's well name, route and NDIC metadata. The governed job type is `fresh-water-tank-refill` with `lifecycle` and `pickup` capabilities; it has neither `multiHaul` nor `splitTicket`.

Fresh-water inventory is independent of produced-water pull levels. WB-T's PW relay must only send physical produced-water pulls. WB-M records fresh-water deliveries. The Dashboard's Fresh Water Tanks page shows a separate refill queue, ranked by estimated days to empty.

## Pad setup

Staff with `manageWells` configures `well_config/{wellName}/freshWaterSupply` through the Dashboard Fresh Water Tanks page and `staffConfigureFreshWaterPad`:

```json
{
  "wellName": "Example 1",
  "config": {
    "enabled": true,
    "tankCount": 2,
    "tankHeightFeet": 20,
    "bblPerFootPerTank": 20,
    "dailyUseBbl": 3
  },
  "initialLevelFeet": 10
}
```

The optional initial reading seeds inventory once. An active pad's geometry and starting use rate cannot be silently changed; that requires a deliberate inventory migration. Tanks are modeled as connected, equalized, and the same size. The 3 BBL/day rate above is an example; each pad has its own rate.

## WB-M calls

`getWbmFreshWaterSupply({ wellName })` returns the pad configuration and a status with `levelFeet`, `asOfUTC`, `projectedFeet`, `dailyUseBbl`, and the last measured level/time. Status is null until the first reading is seeded or a first measured delivery is recorded.

`ingestWbmFreshWaterDelivery` accepts one load:

```json
{
  "wellName": "Example 1",
  "deliveryId": "stable-unique-id-for-this-load",
  "deliveredAtUTC": "2026-10-27T12:00:00.000Z",
  "deliveredBbl": 120,
  "measuredBeforeFeet": 10
}
```

`measuredBeforeFeet` is optional after a pad has a starting level. A pumper or driver reading can correct the estimate; the driver does not need to send a top/bottom message to WhatsApp. The server derives driver and company from secure authentication, checks the assigned route/well and company, and records a load exactly once by `deliveryId`. Repeating the same load ID and values returns `duplicate: true`; changing them returns a collision error. Offline loads can arrive out of order after the starting reading; the ledger replays them in delivery-time order. The endpoint refuses a load that would exceed tank height.

The calculation is `newLevelFeet = levelBeforeFeet + deliveredBbl / (tankCount × bblPerFootPerTank)`. Between deliveries, the projected level falls by that pad's `dailyUseBbl`. Two measured readings at least 12 hours apart can update the rate after accounting for intervening deliveries. The server stores status and the idempotency ledger under `fresh_water_supply/{companyId}/{wellName}`; it does not modify PW `packets/processed`, `packets/outgoing`, or the PW production-rate calculation.

## WB-T ticket

The ticket remains one hourly service job. Its type is `Fresh Water Tank Refill`, distinct from `Fresh Water`. One job represents one delivery; split and multi-haul actions are absent from the governed packet. WB-T does not send a PW pull packet for this type. WB-M's `deliveryId` should be linked to the ticket/job identity when that end-to-end association is implemented; this initial endpoint deliberately does not trust a client-supplied ticket ID as proof of a ticket.

## Release order

WB-M now has a dedicated Fresh Water Tank Refill screen, reached from More. It lists configured pads on the driver's authorized routes, queues one load durably on the phone, and retries with the same delivery ID. A permanent server refusal stays visible for review. The screen does not yet bind the delivery to a WB-T ticket, so dispatch must reconcile ticket and delivery manually during the pilot.

The new job type must be published as immutable `water-hauling` packet revision 5 for the company before WB-T offers it as a governed job. Cloud callables, Dashboard Hosting, WB-M, and WB-T builds must correspond to the same release. No live pad inventory should be seeded from the example in this document.
