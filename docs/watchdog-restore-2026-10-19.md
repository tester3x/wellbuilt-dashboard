# Watchdog dashboard restore - 2026-10-19

Live Watchdog route served the older default-off condition (enabled required), while the previously verified Watchdog release uses default-on with explicit disabled opt-out. The release/dashboard-current-20260927 lane contains recent completed-date and demo updates but lacks the previously released Watchdog navigation/Refresh, Water Orders, preferred drop-off and cancelled dispatch repairs.

Hotfix branch starts from certified Watchdog checkpoint 2441657a, retaining those approved features, and carries completed-date changes 79f8df5b/9f954a04 plus demo capture URL changes 1ee230d9 and current approved demo assets. A preflight check now inspects the freshly exported Watchdog page for missing/disabled output. Company permissions and review APIs are unchanged.

Hosting-only repair; no Functions, rules, reviews or load decisions. Backend JSA numbering work remains separate and undeployed. Certified preflight and live byte verification required before recording this repair as deployed.
