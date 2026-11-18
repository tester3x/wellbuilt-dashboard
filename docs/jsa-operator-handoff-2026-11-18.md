# JSA operator handoff repair — prepared for release

A new driver test job had its chosen operator saved in the invoice and visible in WB Tickets Job Review, but JSA's missing-operator save guard rejected it. The legacy protected read response exposed the owner-verified invoice's well and job type only. The JSA adapter then generated a well entry with an empty operator. The new guard exposed that older handoff omission.

The protected read projection now includes the invoice operator after the existing company/driver authorization checks. The value is trimmed and limited to 300 characters. Missing or malformed optional values remain omitted so sparse historical reads retain their existing behavior; JSA submission still refuses a missing operator. No launch hint supplies this value. No signed artifact, invoice, JSA period or shift is written by this change.

Checks: Functions TypeScript build and governed request/receipt matrix (142 passing checks), including authorized operator transfer, foreign-owner refusal and bounded output. The matching WB JSA client must retain this field through its context parser and frozen well/save adapter.

Not deployed. Mike requested retaining JSA 116 during the active S24 test. Stage this scoped protected-get change with the matching app release; no Hosting, rules, Auth, Watchdog or unrelated Functions deployment is part of this checkpoint.
