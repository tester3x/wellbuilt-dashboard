# Vendored qualification artifacts

`wellbuilt-contracts-0.1.0.tgz` — the LOCAL @wellbuilt/contracts
qualification artifact (same bytes as the Dashboard root install;
integrity sha512-hrSemO9jchaMxCQE17huCZHXpws0MNVCiRgboqjEn/p8L0eOnhQukQbR4jgphv9xxLur9HziamVUzyMUXVgjaA==).

Vendored INSIDE functions/ so the deployable artifact carries no
absolute or repo-external path (firebase deploy packs only this
directory). The package is not published anywhere.

REGISTRY REPLACEMENT (when the package is eventually published):
1. `npm uninstall @wellbuilt/contracts`
2. `npm install @wellbuilt/contracts@0.1.0 --save-exact` (private registry)
3. delete this vendor/ copy
4. verify the lockfile integrity matches the published artifact
5. re-run tools/test-contractsConformance.mjs and the functions build
No source files may duplicate the contract schemas in the meantime —
functions code imports @wellbuilt/contracts exclusively.
