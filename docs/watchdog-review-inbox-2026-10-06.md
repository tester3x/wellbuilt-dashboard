# Watchdog review visibility

Added a persistent Needs review inbox, header count, browser-title count and clickable badges on live group headers and watched group names. The inbox uses all retained queued posts, not the recent 200 messages or 100-post live feed. Reviews remain until the delivery status is resolved. Existing confirmation/exclusion controls and delivery safeguards are reused. Polling preserves focused review forms. Group settings child positions remain unchanged.

Validation: 13 watchdog tests pass, including retained reviews older than the recent-feed cutoff and removal of resolved reviews. Local service reloaded with saved session; Connected, Watching, WB M Ready, six groups and no error verified. Browser inbox verified. No review was confirmed or excluded by this change.

Remote alerts: user requested overseer choice of email and/or WhatsApp when contact details are provided. Delivery integration and recipient setup remain pending; no remote notifications were sent. Proposed WhatsApp group names: Watchdog Review Alerts or Watchdog: Heads Up.
