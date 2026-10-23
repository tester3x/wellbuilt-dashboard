# Water Orders live delivery test and server-only persistence

The first live browser test stopped before dispatch creation: the deployed
Firestore rules intentionally deny direct writes to projects. The older Water
Orders implementation attempted browser transactions for order save and sent-job
acknowledgement. Synthetic tests had not exercised those deployed permissions.

The client now uses staffWriteWaterOrder. The callable uses the same trusted,
company-bound manageDrivers capability as staffWriteDispatch, validates plan and
frozen-record shape/size, verifies selected canonical driver profiles, stamps the
project creator from authenticated identity, and preserves immutable retry data.
Acknowledgement reads the actual dispatch in a transaction and verifies company,
project, driver, source and quantity before recording its ID. No Firestore rules,
claims or staff grants are changed. Dispatch creation remains governed by the
existing writer and packet/catalog checks.

The real setup also exposed a narrow-screen fieldset minimum-width problem and
the cost of deselecting a large source list one checkbox at a time. The fieldset
now permits its tables to scroll within their containers. Source controls can
use only shown matches, allow shown matches or exclude shown matches explicitly.

Backend source b92a754c: eight focused tests passed across water-order and driver
signal suites; functions TypeScript passed. The full browser workflow now mocks
the callable boundary rather than implying direct project writes are supported.
It verifies the builder itself has no sideways scrolling at four widths.

Live order testing is restricted to an existing dedicated test driver and test
locations, with every production source excluded. Test jobs are declined after
verification; no shift, inspection, JSA, invoice or measured water pull is created.
Dashboard source 16c89f7b98a60ce9691eb49df7b9d5739d9d5de4 deployed successfully;
all 362 exported artifacts byte-matched live after mandatory preflight.
The named callable is ACTIVE at revision staffwritewaterorder-00001-pak;
an unsigned invocation returns HTTP 401. No rules or account grants changed.

Real browser retry saved the two-load test order and sent its first 40-BBL job
through staffWriteDispatch. A server-side read independently verified the sole
recipient's canonical test identity, test source/destination, project binding and
the confirmed sent ID. The second job remains uncreated while the first is
pending. Device-level receipt, decline, second release and cleanup remain pending
the connected S24's unlock. The phone's lock screen was verified; no attempt was
made to bypass it. This is not yet a completed app-delivery test.

Private order IDs, phone evidence and logs are stored outside Git. The browser
regression now also explicitly rejects direct project transaction/write calls in
WaterOrderBuilder, preventing a return to the rules-denied save path.
