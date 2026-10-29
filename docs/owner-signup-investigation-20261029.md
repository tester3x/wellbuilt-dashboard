# Owner signup investigation — not a release

User requested investigation of an existing WB invitation after consultation and authorized reusing/moving existing registration code if appropriate.

Evidence in current source and Git history:
- `8b5c590a` (June 23): pending self-signup activation in Admin → Companies creates a company and binds its owner. This was not an emailed invitation wizard; its commit explicitly excluded email/wizard work.
- `6dffbdab` (September 16): recovered company onboarding and join-code callable lineage.
- `dc4ee4c1` (September 20): platform company list/create/approve callables deliberately fail closed until trusted platform-global capability is defined.
- Current `src/app/page.tsx` still displays the awaiting-WellBuilt-approval banner. `CompaniesTab.tsx` still has pending requests and Create Company UI.
- Marketing Get Started links to Contact. No separate consultation/company invitation token flow was located in the searched source, history or local Markdown. Absence from this search is not proof it never existed elsewhere.

The accompanying owner signup implementation is an UNFINISHED, UNDEPLOYED prototype preserved for recovery. Functions compilation and Dashboard TypeScript passed; security/runtime tests and deployment have NOT occurred. It currently proposes self-service creation and must not be treated as an approved replacement for platform onboarding. Reconcile the intended entry/access model before any release. Existing platform onboarding fail-closed guards remain unchanged.

No company/account was created; no APK, Hosting or Functions deployment was performed for this prototype. Website remains unchanged.
