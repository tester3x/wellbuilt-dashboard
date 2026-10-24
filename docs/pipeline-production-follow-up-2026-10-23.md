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

Thirty-eight focused tests cover the production estimator, actual AFR entry-point,
overnight boundaries,
continuous hauling and refresh, including independently retained ON and cold-cache
guards. Both lane and exact live-source compilation pass.
Customer values, histories, receipts and operational backups stay outside Git.

Source cd915d54 is deployed through source-only overlays for the incoming-pull,
delete, edit and edit-outbox handlers. Every deployed archive byte matches its
prepared overlay; triggers, runtime settings and IAM are unchanged. The incoming
and delete archives change only the three refresh files. Edit/outbox archives
also receive the existing overnight helper's three files, absent from those
older scoped archives. No Hosting, rules or APK release was needed.

The full nine-well route audit found one additional active well with sufficient
verified evidence for inventory-mode activation. Native WhatsApp history, durable
receiver rows and canonical processed receipts agree on all observations in its
sample. Its configuration was conditionally opted in; refresh readback verifies
the corrected AFR and independent ON while original history, current gauge,
ownership, latest pull and down state stay unchanged. A dormant well's stale ON
projection was separately corrected using its actual historical interval, without
changing its last-pull date or representing it as fresh production.

The remaining wells include an unconfigured new pad, a no-history pad, dormant
wells with old/inconsistent measurement evidence, and two wells whose recent
barrel quantities remain provisional. They were audited, not force-enabled. The
owner was asked for the missing actual quantities. Last verified AFR is retained;
no ON figure is invented where eligible overnight evidence is absent. Historical
daily log snapshots remain as originally recorded.
