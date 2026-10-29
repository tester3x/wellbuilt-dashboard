# DVIR inspection profiles: desktop implementation checkpoint

Status: code staged in the registered Dashboard home only. No Functions deployment, Hosting deployment, Storage rules deployment, media upload, default catalogue publication, company selection, or customer report change has occurred.

## Contract and ownership

The six version-1 callable names and manifest fields follow `docs/dvir-inspection-profiles-contract-v1.md` on WB eQuipment's `codex/wbe-shop-20261012` branch. The canonical Firebase project is `wellbuilt-sync`, `us-central1`. WB eQuipment owns the phone cache, in-app admin editor, and inspection rendering; this repo owns the optional Dashboard editor and Firebase service. Inspection profiles are independent of transportation job packages and subscriptions to WB Tickets, Suite, or JSA. A driver can read; a live company admin can manage. Dashboard may pass a company ID only as a requested scope, and the server compares it with a live membership. Driver identity is rechecked through canonical credentials/profile records; client `isAdmin` is never accepted.

Implemented callable exports: `listEquipmentInspectionProfiles`, `getEquipmentInspectionProfile`, `saveEquipmentInspectionSettings`, `saveEquipmentInspectionDraft`, `publishEquipmentInspectionProfile`, `beginEquipmentInspectionPhotoUpload`. The Dashboard editor is behind `NEXT_PUBLIC_DVIR_PROFILES_ENABLED=true` until backend, media rules, and defaults are deployed. A company admin can select profiles, set the default, assign registered trucks, preview areas, edit title/area/item text, add/remove items or areas, replace an area's photo, restore the current published version, save a draft, and publish it. An area with no photo cannot publish. The shortcut in the Equipment table opens the editor.

Firestore staging layout: shared pointers in `equipment_inspection_defaults/{profileId}`, company pointers in `equipment_inspection_companies/{companyId}/profiles/{profileId}`, immutable `revisions/{revision}` under each pointer, company draft/upload receipts under the company root, and company choices in the company root document. The server uses Admin SDK for these records. Client Firestore writes are absent. The existing committed Firestore rules are not a deployable authority source for this new feature; review the actual deployed rules before any rollout.

Media uses the contract's `equipment-inspection-defaults/...` and `companies/{companyId}/equipment-inspection-media/...` paths. Upload requests require JPEG/PNG, at most 8 MiB, a SHA-256 digest, and a company-authorized session. Signed PUT URLs include content type, hash metadata, and an object-generation-zero precondition. Publication re-downloads each referenced object and checks size, SHA-256, MIME, and file signature. Published revisions are immutable and use an optimistic draft/base revision check. The file path and exact hash are in the manifest; signed read URLs are transient and must never be stored in inspection reports. Customer upload/revision writes must remain disabled until deployed Storage rules deny direct client access to both profile media prefixes and CORS permits the signed PUT headers.

`scripts/stage-dvir-profile-defaults.cjs` reads the registered WB eQuipment source without modifying it and generates review manifests plus source-file mappings in `docs/dvir-profile-defaults/`. The hot-oiler candidate has 9 areas/9 images; the water-hauler tractor/tanker candidate has 12 areas/12 images. Approved image variants were selected where available: hot-oiler front v2, panel v2, piping v3, heater v2, pump v2; water-hauler coupling/pump v4. The remaining hot-oiler views still need final visual review. No marshmallow outtake is in the formal default. `scripts/publish-dvir-profile-defaults.cjs` is dry-run by default and verifies local source hashes; its `--publish` mode requires an explicit environment gate and must not run until the Storage boundary, catalogue review, and deployment scope are approved. It creates immutable default revisions after uploading/verifying media.

## Verified checks and rollout gaps

- Functions TypeScript build passed; Dashboard TypeScript check and Next production build passed.
- Focused Jest validation and authorization tests passed. The staged manifests passed the server validator and publisher dry run.
- Storage emulator authorization tests have not run; Firebase CLI is unavailable on this desktop. The checked-in `storage.rules` currently says `allow read, write: if true` for every path and is expressly forbidden as a deployment source by Dashboard `AGENTS.md`. The production rules owner must merge a deny-by-default boundary for these media prefixes into the **actual deployed** rules and verify cross-company denials in the emulator before any service deployment. Signed URLs use Cloud Storage credentials and bypass client rules, so rules must deny direct client reads and writes.
- Functions and Dashboard are not deployed. No end-to-end phone download, offline activation, app editor round-trip, signed report provenance, Storage CORS, or real customer authorization test has been performed. Laptop WB eQuipment cannot claim live round-trip success yet.
- The Dashboard editor currently saves drafts durably on the server but keeps the draft ID only in the current page session; a cross-session draft picker is still needed. The phone team owns the required in-app editor.
- The staged hot-oiler images and checklist remain product candidates. The hot-oiler pack is not yet production-selectable.

## Required integration sequence

1. Reconcile the exact version-1 contract with laptop WB eQuipment after its current work is pushed. Preserve its independent repo ownership.
2. Merge secure media-prefix rules into the live rules authority and verify authenticated company isolation, direct-client denial, signed PUT behavior, and CORS in emulators. Do not deploy this repo's stale broad rules.
3. Review and approve the staged default images/checklists; publish only reviewed revisions and verify stored hashes.
4. Deploy the six Functions from a verified scoped source commit, enable the Dashboard flag with the approved Hosting release path, and test Dashboard and phone round-trips with an owner-operator, driver, and another company.
5. Only then call the feature production-ready. Existing DVIR reports and app data must be preserved.
