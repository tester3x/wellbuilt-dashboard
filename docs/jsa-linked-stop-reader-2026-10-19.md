# Current recorded stops for the saved JSA drawer

readSavedJobJsa now returns coveredJobs alongside its original signed snapshot.
The original read's recorded location/activity and manual locations are included;
later well/job-type/designated-drop-off snapshots come only from owned acknowledged
jobs or scope coverage whose explicit fullReadId matches the verified full read
and whose recording time is at or after that read. Other full reads, earlier rows,
foreign owners and invalid artifacts do not enter the roster. These are recorded
job details, not claims that the driver arrived at a designated drop-off.

Existing signed documents and identifiers remain unchanged. The callable uses
owner-scoped fullReadId queries for the two stop collections. Both query shapes
were verified read-only against live Firestore with existing indexes.

Validation: Functions build and12 saved-job tests. Deployed only jsaGetSavedJob
from58f69f4e on2026-10-19. Verified ACTIVE revision jsagetsavedjob-00003-com,
updateTime2026-10-19T19:58:00.595629807Z, signed-out401 at19:59:19Z. No rules,
indexes or Hosting deployment; no customer evidence records changed.
