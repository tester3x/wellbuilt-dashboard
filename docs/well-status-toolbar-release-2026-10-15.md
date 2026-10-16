# Responsive Well Status toolbar release

Source 08a8a059 on release/dashboard-compact-identity-20261015. Well Status/search/Add Pull now wrap as a coherent group with nonshrinking title/action labels and a fluid narrow-screen search. The utility controls use compact gaps and keep their groups intact. Partial widths use two deliberate rows; wide layouts retain a compact shared row with wrapping available for narrow content containers. The collapsed unrouted-ticket section remains below routes.

The regression renders the actual shipped toolbar JSX with the fresh compiled Tailwind stylesheet in Chromium at 344, 768, 1024, 1280 and 1536px, plus 1000px content inside a 1536px viewport. All six cases pass no page overflow, no escaping/overlapping controls and a single-line Add Pull action. Certified Hosting preflight passed; live Mobile HTML and all 18 JS bundles byte-match the fresh build after deployment on October 15, 2026 (America/Chicago). No backend/rules changes.
