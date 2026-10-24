# Pipeline production follow-up

The route audit compares existing calibration, completed observations, independent
overnight samples and a same-phase inventory/withdrawal balance. An unavailable
or provisional quantity is not confirmation of production. New, dormant and
unconfigured wells must not inherit another well's calibration or a fabricated
rate. Historical observations remain unchanged.

Refresh now recomputes an opted-in well's overnight figure independently instead
of clearing it whenever inventory AFR is refreshed. Continuous-hauling mode still
suppresses ON explicitly; windowed-flow behavior remains unchanged. Latest-pull
guards, original measurements and ownership are preserved.

Thirty-five focused tests cover the production estimator, overnight boundaries,
continuous hauling and refresh, including independently retained ON and cold-cache
guards. Source compiles. Live rollout and well-specific verification are pending.
Customer values, histories, receipts and operational backups stay outside Git.
