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
Deployed from 3be852dc on October21,2026. Both functions are ACTIVE:
scheduledwellcatalogrefresh-00004-giq and triggerwellcatalogrefresh-00004-wif.
Downloaded deployed source matches the checkpoint's refresh and classifier files.
Comparing service configuration before/after found only the expected revision
change for each; runtime/service settings were preserved. No full-catalog write
run was triggered as a test. Targeted official catalog repair and the user's
missing split-leg repair were separately scoped and audited with private backups.
