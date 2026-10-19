# JSA 69 / WB T 195 deployment and installation

Backend source af761ab4 deployed only jsaHomeState and createDriverDispatchIfAbsent.
Verified 2026-10-19T21:33:54Z:
- jsaHomeState ACTIVE revision jsahomestate-00002-miv, signed-out 403.
- createDriverDispatchIfAbsent ACTIVE revision createdriverdispatchifabsent-00010-gaz, minInstances 1, signed-out 401.
No rules, indexes, Hosting or customer record changes.

| App | Source | Build ID | Version |
| --- | --- | --- | --- |
| JSA | edbf9d3f3a98d8667313ed1e031c5755d164a1e4 | 244e5838-533d-43f0-b8ad-c53229c96961 | 69 |
| WB T | 5b561b1054dc6234eb606e2fd2e61443bf1a046b | 0bdcd896-583c-42f7-9e29-cbe994af94d5 | 195 |

Both preview APK builds finished. Update-installed JSA 69 and WB T 195 on ZFold RFGL23VJCED and S10 R52XA06CDQE. Verified APK signatures, package names, versions, SHA256, and preservation of app UID/original first-install time. Existing app data preserved.
Private build metadata, hashes and device identity receipts: C:/dev/tmp/jsa-resume-release-*.
App typechecks and relevant JSA document/home/projection, WB T viewer/delivery tests passed; Functions build and 13 home-state tests passed.

APK SHA256:
- JSA: 75A5859F09AAD9A09E4266BDE156A5A377BF899D347739713D347367224B6261
- WB T: CA557D353AE4F03E1BA08BE1FB94FC116FDBDA49981DBF30A9886948214F3359

User testing remains: Resume original local assessment, company/jobs list, saved signature rendering, and self-created job delivery/start label. Installation verification does not establish these UI outcomes.
