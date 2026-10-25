# Job-scoped saved JSA lookup

The saved-job reader now loads acknowledgements/coverage for the exact owned job.
An explicit fullReadId resolves one exact request rather than scanning the driver's
entire governed history. Direct-read jobs query their jobRef; legacy unlinked
acknowledgements retain the historical owner-scoped lookup. All invoice/request/
artifact ownership, request identity, chronology and allowlisted snapshot checks
remain enforced. No user records or identifiers are modified.

Validation: Functions build and11 saved-job tests pass. Read-only live queries for
all three scoped collection shapes succeeded with existing indexes. This source
has not been deployed; no rules/indexes/Hosting changes were made.
