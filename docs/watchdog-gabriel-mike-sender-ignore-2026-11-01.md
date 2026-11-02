# Gabriel Wells: ignore Mike's WhatsApp posts

Mike requested that Watchdog ignore his WhatsApp posts in the `Gabriel Wells` channel because he records those pulls in WB-M or WB-T. This does not apply to his posts in other watched channels or to other senders in Gabriel.

## Source and installation

- Source change: `f611a612791fc84a540d4421411335c2ad2c4ee2` on `release/dashboard-current-20260927`, pushed to `origin`.
- Source files: `tools/whatsapp-watchdog/server.mjs`, `sender-ignore.mjs`, and `sender-ignore.test.mjs`.
- The rule compares the WhatsApp channel ID and SHA-256 of the sender ID before queue ingestion. It does not rely on the displayed author name, parse a post, or send it to the pull receiver when the pair matches. The private `sender-ignore.json` supplies the one channel and sender hash; no WhatsApp IDs are committed.
- Installed on HP `Watchdog-Command`, existing operational checkout `C:/dev/WellBuiltWatchdog`, branch `codex/watchdog-combined-time-20261019`, HEAD `42a1adc3cbb07024514a9f8d39b8d8f91d3f6ab2`. This is a scoped installation overlay, not a commit on the HP branch. Existing dirty/untracked HP work was preserved.
- HP changed `tools/whatsapp-watchdog/server.mjs` (SHA-256 `8DEEE00FDFF9120AFDC74555B3BAA60A82A0DC247649F2BA5A1B230CDAC349A8`) and added `sender-ignore.mjs` (SHA-256 `8BDC118DC5FF58A2B3A3A89129D18744D03BC6E8FA468421ED82686DE2A2D141`). Its private configuration is `C:/Users/miknd/AppData/Local/WellBuilt/WhatsAppWatchdog/sender-ignore.json` (SHA-256 `11800735F2DA01B0EF8A7B272C086495C2CB4C78829634D359A45AD089AF1B2B`). Do not copy that configuration into Git or a packet.
- The exact pre-change HP server file was preserved at `C:/Users/miknd/AppData/Local/WellBuilt/WhatsAppWatchdog/install-backups/server.mjs.pre-mike-gabriel-ignore-20261101` (SHA-256 `F531331141B03E46EDD542C347B81BE5337B74ADE2D2E6751E58F91793F34E92`).

## Verification

- The desktop source passed `node --test tools/whatsapp-watchdog/sender-ignore.test.mjs` (2 tests), the Watchdog suite (19 tests), `node --check` for the server, and `git diff --check`.
- The HP installed module and server passed `node --check`. After restart, the HP was `Connected`, unpaused, transport `Ready`, receiver check 8 seconds old, with 9 channels, 0 pending deliveries, 1 unrelated review item, and no receiver or review-sync error at `2026-11-02T05:33:30Z`.
- A read-only probe of the **installed helper and live metadata** returned `mikeGabriel=true`, `otherSenderGabriel=false`, and `mikeOtherChannel=false`. The selected sender came from 22 recent posts displayed as `Mike B`; the same internal sender ID also appeared under WhatsApp's numeric display form.
- No new real Mike post was sent to test live ingestion. Future posts are the remaining end-to-end observation. Existing historical receipts and the unrelated review item were left intact.

The first HP restart exposed a missing import in the installed overlay (`isIgnoredSender is not defined`). The declaration was added and the worker restarted through the existing supervisor; the healthy state and rule probe above are from the corrected process. No Dashboard Hosting, Functions, mobile app, or database rules deployment occurred.
