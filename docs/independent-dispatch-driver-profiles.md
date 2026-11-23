# Independent Dispatch driver profiles

The driver profile editor under Independent Dispatch records work context for both outside drivers and linked WellBuilt drivers. It is company scoped and available to staff with `viewDispatch` and `manageDrivers` in a company with the Independent Dispatch package.

## Current behavior

- A profile can name a primary customer or operator, describe standing route work, and record whether side jobs are normally possible. These fields are planning context. They do not move standing work to another driver or calculate free time.
- Staff can record a dispatch observation, operator feedback, and a pending management review for a saved customer or operator. A pending review is not an approval decision, does not notify management, and does not restrict assignment.
- Every driver remains eligible for every operator by default. The assignment picker still uses the driver's active roster state and open job time conflicts. It does not infer skill or operator eligibility from these notes.
- Each profile save has a revision and server-side revision history. The client must refresh after a conflicting edit.

## Later decisions to make with dispatch management

- Who may recommend and who may approve an operator-specific restriction; how operator feedback is received and verified; whether urgent temporary holds exist.
- How the decision is communicated, reviewed, expired, and reversed after training or operator approval.
- How standing route schedules, travel, and side jobs affect availability. Free-text standing work is not a scheduling engine.
- Customer-specific hourly and barrel rates, driver share, and actual billable activity for a fair pay-period comparison. No pay estimate is inferred from job counts alone.

Do not turn pending notes into assignment blocks or automatic driver rankings without an approved decision process and verified rate and schedule data.
