# Standalone assessment archive deployment

Code: 11267ba5, feat/jsa-standalone-company-access-20260913.

Optional create job fields archive the read assessment steps and customer. Step IDs must be unique, acknowledged, and cover the complete acknowledged set. Text sizes and field names are bounded. Additions must retain the recorded customer; old records without the new fields remain compatible. Existing create idempotency, append evidence and original-content immutability are retained.

Verification: Functions TypeScript build passes, 46 memory cases and 47 Firestore emulator cases pass. The emulator includes direct database denial; all fixture writes stay in jsa_standalone_companies. No production fixture submissions.

Fresh predeploy source comparison: all 239 source files in ACTIVE jsastandalone-00002-xen matched 3b14a506 (zero differing/missing files). Deployed only functions:dashboard:jsaStandalone to wellbuilt-sync. Confirmed ACTIVE jsastandalone-00003-nix. No rules, Hosting, indexes, photo or other Functions deployment. Deployment evidence is retained locally under C:/dev/output/dashboard-audit-20260912/jsa38-deployed.json.
