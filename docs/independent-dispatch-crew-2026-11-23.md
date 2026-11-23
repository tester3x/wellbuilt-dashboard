# Independent Dispatch crew assignments

Independent Dispatch jobs can have several drivers. Each assignment records the
driver source, display name, assigned time, and day or night shift. Dispatch can
add a driver, remove one, or replace one while preserving the other crew members.
The job may also record a customer's requested driver count. The paste parser
fills it only from an explicit staffing request; tank count, volume, and a
completion deadline do not imply a crew size. Dispatch reviews and may edit the
count before saving. Job cards show assigned drivers against the requested count
without blocking a partial crew or forcing one for a fill-by order.
The board picker has checkboxes and an individual shift selector for each checked
driver. Add/Assign saves the selected crew in one transaction and one job revision;
if any selection is unavailable, none of the checked drivers is added.
Assigned crews appear in equal-width Day and Night lists on the job card. Each
list shows about three drivers before scrolling. Older assignments without a
shift remain visible in a separate compact list until categorized.
The job event records the before and after roster. Existing single-driver jobs
are read as one-member crews and are upgraded when their roster changes.

The job's shift may be day, night, both, or unspecified. The separate shift on
each crew member is the working assignment. Selecting a driver defaults to
their saved Day or Night preference when available. Otherwise it uses the
job's Day or Night shift, or remains unset. Dispatch can override each selected
driver's shift before assignment. Outside drivers have their preference in the
roster, and linked WellBuilt drivers may set it in their Independent Dispatch
profile. A different shift preference never blocks an assignment.

Driver profiles are under `/dispatch/independent/drivers/`, reached from the
board toolbar. The same package and staff capabilities still guard the data.
The board keeps the outside-driver roster controls.

Open-job conflicts still block a driver across jobs unless finish times prove
they do not overlap. A driver may stay on the same job alongside other drivers.
HOS is shown as unverified because this Dashboard has no trusted HOS eligibility
feed. It does not prevent assignment. No ID job is sent to the WB driver phone
app or to SMS/WhatsApp by this change.
