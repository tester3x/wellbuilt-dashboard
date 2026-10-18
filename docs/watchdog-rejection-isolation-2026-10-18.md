# Watchdog rejection isolation — 2026-10-18

Branch: codex/watchdog-rejection-isolation-20261018. Source checkpoint e7f79c9a.

Authenticated sender ownership rejection returns a durable review disposition to the existing receiver instead of failing the entire tick. Ownership/company/route checks remain enforced; no unowned packet is written. Client transport also isolates each row, retains rejected rows with their issue and original observation, and continues later messages; transient failures remain retryable. Top-only rejection disposition is not cleared by the legacy policy retry path.

Verification: Functions TypeScript build passed; six sender ownership tests passed; seven transport isolation/receipt tests passed; 29 queue/review/dismissal checks passed. Only dashboard:ingestWatchdogPullV2 deployment requested. No Hosting, rules, APK or other Function deployment.

Investigation: cloud's last accepted delivery at 05:11:30 America/Chicago was Kahuna 5. Current owner profile includes Gabriels, Thor 1's route. No relevant route/assignment security audit entries since 05:00. Sender-scope check originated October 5. The first rejected observation and any later backlog are not yet available in the cloud mirror. HP direct SSH times out from the field. Do not claim full recovery until fresh canonical receipts prove it. Do not bypass sender scope or synthesize missed loads.

Client runtime fix is committed/pushed but not installed on HP; source must be compared against HP runtime branch before fast-forward/integration. Pending: confirm scoped server deployment, let receiver retry, inspect review item, verify all captured post-05:11 deliveries against processed receipts, reconcile any messages not captured locally once HP is reachable.
