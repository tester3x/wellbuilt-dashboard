# Independent Dispatch and Dialpad groundwork

Source: `release/dashboard-independent-dispatch-20261120`. The Independent Dispatch job package has five sector forms and a company-owned customer directory. Prairie Route Dispatch is a separate production tenant with the package installed and five synthetic sample customers/jobs. Its owner email is `wellbuiltllc@outlook.com`; no password or Dialpad credential is stored in this repository.

## Current handoff

- Customer settings accept an optional E.164 phone number. Outside drivers already have E.164 phone numbers in their roster.
- A job with a saved customer or assigned driver phone shows a Dialpad app link. The link requires confirmation and passes only the Independent Dispatch job ID in `customData`. No call is placed by the Dashboard and no call or message is recorded as completed by this link.
- The sample account contains no real customer or driver phone numbers, so its call links remain hidden until real numbers are entered.

## API connection when the Dialpad account is ready

Dialpad documents [app launch URLs](https://developers.dialpad.com/docs/app-launch-urls), [outbound call initiation](https://developers.dialpad.com/reference/usersinitiate_call), [SMS sending](https://developers.dialpad.com/reference/smssend), [call events](https://developers.dialpad.com/docs/call-events), [SMS events](https://developers.dialpad.com/docs/sms-events), and [OAuth for multi-company integrations](https://developers.dialpad.com/docs/oauth). The product should use per-company authorization, verify signed webhook events, deduplicate and order events, bind them to company and job IDs, and show actual provider outcomes. Obtain Dialpad app registration and tenant consent before enabling these operations. No Dialpad credential or webhook exists yet.

The initial user priority is calling customers and drivers. Call/SMS history and outbound messaging can follow once the Dialpad account and scopes are available.
