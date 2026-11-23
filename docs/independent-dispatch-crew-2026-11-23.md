# Independent Dispatch crew assignments

Independent Dispatch jobs can have several drivers. Each assignment records the
driver source, display name, assigned time, and day or night shift. Dispatch can
add a driver, remove one, or replace one while preserving the other crew members.
The job event records the before and after roster. Existing single-driver jobs
are read as one-member crews and are upgraded when their roster changes.

The job's shift may be day, night, both, or unspecified. The separate shift on
each crew member is the working assignment. A driver's usual shift is only a
planning cue: outside drivers already have it in the roster, and linked
WellBuilt drivers may set it in their Independent Dispatch profile. A different
shift preference never blocks an assignment.

Driver profiles are under `/dispatch/independent/drivers/`, reached from the
board toolbar. The same package and staff capabilities still guard the data.
The board keeps the outside-driver roster controls.

Open-job conflicts still block a driver across jobs unless finish times prove
they do not overlap. A driver may stay on the same job alongside other drivers.
HOS is shown as unverified because this Dashboard has no trusted HOS eligibility
feed. It does not prevent assignment. No ID job is sent to the WB driver phone
app or to SMS/WhatsApp by this change.
