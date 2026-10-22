# Confidential NDIC work locations

NDIC publishes some newly drilled/permitted locations with both status and type
set to Confidential. The importer only accepted active/inactive OG and active
SWD/WI, so valid service-work destinations were absent from operator searches.

The classifier now includes exact Confidential/Confidential rows in wells without
changing their true NDIC status or type. Active disposal and inactive oil-well
classification stays separate; unknown combinations are still counted and skipped.
The source uses NDIC's public All_Wells MapServer query, verified against the full
production field list and operator-scoped pagination parameters. The earlier local
VectorTiles endpoint required a token. The deployed Wells FeatureServer endpoint
was also reachable; its omission was the classification rule, not proof of an outage.

Ten classification regression cases pass and Functions compiles. Scope is only
scheduledWellCatalogRefresh and triggerWellCatalogRefresh; no Hosting, rule, auth,
account or unrelated function deployment is authorized by this checkpoint.
Live deployment identity and verification are appended after deployment.
