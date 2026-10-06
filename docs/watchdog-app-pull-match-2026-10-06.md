Watchdog app-pull matching release

Automatic suppression requires one preceding app pull within 90 minutes, same well and verified driver ID, equal barrels, top within one inch, reported bottom within two inches of the app bottom, completed canonical processing, and no intervening pull. Incoming, ambiguous, unowned and conflicting candidates are held for review. Matching returns the existing packet ID and UTC gauge time; no new incoming packet or delivery claim is created. Explicit confirmation can release uncertain candidates but cannot release a strong match. Existing aggregate containment protections remain.

New watchdog packets include an explicit Central display time alongside UTC to avoid the server-local UTC display fallback. Existing history is untouched.

Validation: Functions build; 22 focused Jest tests; 18 watchdog tests; exact previously duplicated observation dry-run matched its original app packet. Production release scope: ingestWatchdogPullV2 only. Remote review endpoints and Hosting remain outside this deployment.

Deployment verified October 6, 2026: source ca784d1f; ingestWatchdogPullV2 successfully updated using functions:dashboard:ingestWatchdogPullV2. A signed historical app/report pair returned duplicate + alreadyRecorded + original packet/time from production. Local page refreshed; Connected, Ready, Watching. No historical pull mutations.
