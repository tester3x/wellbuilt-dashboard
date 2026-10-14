# Top-only driver observations

User confirmed Marcial (Anthony) and Adan currently post on-site top-only readings. Luiz returns October 21; his exact captured sender identity still needs verification. The account owner's readings already arrive through the app. Admin and unverified top-only posts are ignored because their posting time may be hours after measurement. Do not infer measurement times from calculated flow rates.

Parser recognizes a configured well followed by a single top gauge, including `Atlas 1 @ 6' 5" off`. These rows have zero barrels and no reported bottom. Signed intake requires both an explicit canonical-driver start time in server policy and the existing exact-sender binding, active company profile and assigned-well checks. A stated measurement time takes precedence; otherwise the on-site driver's posting time is retained. Provenance distinguishes these observations and their time source. Computed after-level equals top; the word `off` does not change the well's down state. Positive-barrel and estimated loads retain their current path.

Activation is prospective. Existing reviews, delivered packets and historical messages are not replayed. Luiz cannot qualify until his sender is verified, even if his canonical driver start time has arrived.

Validation: Functions TypeScript build passed; 53 existing parser/model/alias regressions, 3 new observation parser tests, 6 ownership tests and the new signed intake/receipt test passed. Local queue/transport tests: 29 passed. The full older intake suite retains pre-existing failures involving decimal gauge fixtures interpreted as feet/inches; an unchanged source baseline also fails. No fix to those unrelated fixtures is included.

Deployment and live receiver verification are recorded after installation. This change does not deploy Hosting or security rules.
