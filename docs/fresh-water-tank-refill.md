# Fresh Water Tank Refill contract

This is a single-load, hourly service job for filling the fresh-water tanks on a producing well pad. It is distinct from the existing `Fresh Water` service type used for frac tanks and hot oilers. It reuses the `water-hauling` packet and the pad's well name, route and NDIC metadata. The governed job type is `fresh-water-tank-refill` with `lifecycle` and `pickup` capabilities; it has neither `multiHaul` nor `splitTicket`.

Fresh-water inventory is independent of produced-water pull levels. WB-T's PW relay must only send physical produced-water pulls. WB-M records fresh-water deliveries. The Dashboard's Fresh Water Tanks page shows a separate refill queue, ranked by estimated days to empty.

## Shared tank-group setup

Staff with `manageWells` configures physical tank groups through the Dashboard Fresh Water Tanks page and `staffConfigureFreshWaterTankGroup`. A group may feed several wells on the same route; a well may belong to at most one group. Wells without fresh-water tanks have no group. The group's name is the driver-facing header.

```json
{
  "routeName": "Gabriel's FW",
  "name": "Gabriel 1 / 4 / 5 / 6",
  "wellNames": ["Gabriel 1", "Gabriel 4", "Gabriel 5", "Gabriel 6"],
  "config": {
    "enabled": true,
    "tankCount": 3,
    "tankHeightFeet": 20,
    "bblPerFootPerTank": 20,
    "equalization": "unverified",
    "dailyUseBbl": null
  }
}
```

The optional initial reading seeds inventory once, but it is refused for an unverified multi-tank group. An active group's membership or geometry cannot be silently changed; that requires a deliberate inventory migration. The Gabriel values above are the authorized test configuration; the equalization fact, usage rate, and starting level remain unknown.

## WB-M calls

`getWbmFreshWaterTankGroups` returns the driver's authorized groups, their linked wells, configuration, and status. Status is null until the first reading is seeded or a first measured delivery is recorded.

`ingestWbmFreshWaterGroupDelivery` accepts one load:

```json
{
  "groupId": "server-assigned-group-id",
  "deliveryId": "stable-unique-id-for-this-load",
  "deliveredAtUTC": "2026-10-27T12:00:00.000Z",
  "deliveredBbl": 120,
  "measuredBeforeFeet": 10
}
```

`measuredBeforeFeet` is optional only when the server can project a level from a known starting level and known use rate. A pumper or driver reading can correct the estimate; the driver does not need to send a top/bottom message to WhatsApp. The server derives driver and company from secure authentication, checks the separate freshwater-route assignment, and records a load exactly once by `deliveryId`. Repeating the same load ID and values returns `duplicate: true`; changing them returns a collision error. Offline loads can arrive out of order after the starting reading when the use rate is known; the ledger replays them in delivery-time order. The endpoint refuses a load that would exceed tank height.

For a single tank or a multi-tank group whose equalization has been explicitly verified, the calculation is `newLevelFeet = levelBeforeFeet + deliveredBbl / (tankCount × bblPerFootPerTank)`. A configured use rate subtracts inventory over time. When use is unknown, the server does not project a current level and requires a new gauge before a later delivery. An unverified multi-tank group cannot use one shared gauge or accept a delivery because overflow cannot be validated safely.

The server stores group definitions under `fresh_water_groups/{companyId}/{groupId}` and inventory with the idempotency ledger under `fresh_water_supply/{companyId}/{groupId}`. It does not modify PW `packets/processed`, `packets/outgoing`, or the PW production-rate calculation. Produced-water assignments remain in `assignedRoutes`; freshwater visibility uses the separate `assignedFreshWaterRoutes` field.

## WB-T ticket

The ticket remains one hourly service job. Its type is `Fresh Water Tank Refill`, distinct from `Fresh Water`. One job represents one delivery; split and multi-haul actions are absent from the governed packet. WB-T does not send a PW pull packet for this type. WB-M's `deliveryId` should be linked to the ticket/job identity when that end-to-end association is implemented; this initial endpoint deliberately does not trust a client-supplied ticket ID as proof of a ticket.

## Release order

WB-M has a dedicated Fresh Water Tank Refill screen, reached from More. It lists configured tank groups on the driver's authorized routes with a tank-count badge and linked wells, queues one load durably on the phone, and retries with the same delivery ID. A permanent server refusal stays visible for review. Legacy per-well queued loads stay visible for review rather than being silently assigned to a group. The screen does not yet bind the delivery to a WB-T ticket, so dispatch must reconcile ticket and delivery manually during the pilot.

The new job type must be published as immutable `water-hauling` packet revision 5 for the company before WB-T offers it as a governed job. Cloud callables, Dashboard Hosting, WB-M, and WB-T builds must correspond to the same release. No live tank inventory should be seeded from the example in this document.
