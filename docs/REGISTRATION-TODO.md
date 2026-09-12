# Registration priorities

- [ ] **P1 — Repair new Register Here employee registration before customer onboarding.** Reported September 9, 2026. User requested high priority, not an immediate deployment.

  Evidence: screenshot of the new employee registration screen (v2.1.0) shows company-name guidance, no visible company join-code field, and submission error “Company join code is required”. The observed employee flow appears blocked. Other registration paths have not been verified, so do not characterize this as a confirmed outage of every registration route.

  Investigate the currently deployed frontend and backend together; the laptop checkout/main may lag the registration release branch. Align visible fields, copy, validation and submitted payload with the intended company join-code flow. Verify Liquid Gold Trucking LLC can obtain its employee join code through the authorized company-admin workflow. Its existing short code LG is not the employee join code; the live join-code pointer was absent when checked.

  Acceptance: a new employee can enter the required company information, submit successfully, and reach the intended pending-approval state for the correct company. Test missing/invalid codes, EN/ES copy, mobile field visibility, and existing sign-in and other registration paths. Preserve the approval requirement. Do not register or approve the person in the screenshot merely as a test.
