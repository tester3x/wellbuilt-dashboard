# WellBuilt Suite

## Project Overview
Next.js dashboard for the **WellBuilt Suite** — a multi-module platform for oil well monitoring, water ticket management, billing, and payroll. Deployed to Firebase Hosting at **https://wellbuilt-sync.web.app**. Replaces Excel-based tracking with Firebase-powered real-time system.

## Tech Stack
- **Framework:** Next.js 16 (App Router, TypeScript, Tailwind CSS v4)
- **Hosting:** Firebase Hosting (SSR via Cloud Run)
- **Database:** Firebase Realtime Database (project `wellbuilt-sync`) + Firestore (tickets, invoices)
- **Cloud Functions:** Firebase Functions (Node.js 20, mix of V1 triggers + V2 scheduled)
- **Auth:** Firebase Auth (email/password)

## CURRENT STATUS (Feb 18, 2026)

### What's Working
- **Tab Navigation** — Shared `AppHeader` with 5 tabs: Home, WB Mobile, WB Tickets, WB Billing, WB Payroll
- **Home (`/`)** — Overview cards with summary stats for each module
- **WB Mobile (`/mobile`)** — Well status page (table + card views, grouped by route), individual well pull history pages (`/well/[wellName]`), admin page, performance drill-down
- **Performance (`/performance`)** — Three-level drill-down: route overview → route detail (`/performance/[route]`) → well detail (`/performance/well/[wellName]`) with pull history table (date, predicted, actual, accuracy %). Matches WB Mobile app calculations exactly.
- **WB Tickets (`/tickets`)** — Water ticket table from Firestore `tickets` collection, with search
- **WB Billing (`/billing`)** — Invoice table from Firestore `invoices` collection, with status filter and expandable rows
- **WB Payroll (`/payroll`)** — Placeholder (Coming Soon)
- **Admin (`/admin`)** — Add/edit/delete wells, NDIC well picker, route management
- **Cloud Functions** — `processIncomingPull` (RTDB trigger), `processEditRequest`, `processDeleteRequest`, `watchdogStrandedPackets` (scheduled), `healthCheck` (scheduled)
- **Mobile app** (separate repo at `C:\WellBuiltMobile`) — sends pull packets to `packets/incoming/`
- **Tickets app** (separate repo at `C:\dev\waterticket-app`) — React Native app for drivers, uses Firestore + RTDB

### Known Bug — Level Column Shows Tank-After, Not Current Estimated Level
**Priority: HIGH**
The Well Status page "Level" column shows the tank level right after the last pull (tank-after / bottom level), NOT the current estimated level accounting for recovery since the last pull.

**Root cause:** The `wells/{wellName}/status.current.level` is calculated at pull processing time by the Cloud Function — it estimates level based on elapsed time since the pull. But this becomes stale quickly. The dashboard reads this value directly without recalculating.

**Fix needed:** Client-side recalculation: `currentLevel = lastPull.bottomLevelInches + (elapsedTimeSincePull × flowRate)`

## Suite Architecture

### Tab System
- **`src/lib/tabs.ts`** — Tab configuration with `matchPrefixes` for sub-page highlighting
- **`src/components/AppHeader.tsx`** — Shared header (branding + Admin/SignOut + tab bar)
- **`src/components/SubHeader.tsx`** — Reusable sub-page header (back link + title + actions)

### Modules
| Tab | Route | Data Source | Status |
|-----|-------|------------|--------|
| Home | `/` | RTDB + Firestore | Live |
| WB Mobile | `/mobile` | RTDB `packets/outgoing` | Live |
| WB Tickets | `/tickets` | Firestore `tickets` | Live |
| WB Billing | `/billing` | Firestore `invoices` | Live |
| WB Payroll | `/payroll` | TBD | Placeholder |

## Firebase Structure

### Realtime Database
- **`packets/incoming/{packetId}`** — Mobile app writes pull packets here (triggers Cloud Function)
- **`packets/processed/{packetId}`** — **THE source of truth for all pull history.** Every processed pull with full calculated fields.
- **`packets/outgoing/{wellName}`** — ONE doc per well with latest status. **Primary source for dashboard home/mobile page.**
- **`wells/{wellName}/status`** — Current well status (written by Cloud Functions, can become stale)
- **`well_config/{wellName}`** — Well configurations (route, tanks, bottomLevel, pullBbls, ndic info)
- **`performance/{wellName_underscored}/rows/{rowKey}`** — Performance cache with `{d, a, p}` (date, actual inches, predicted inches). Keys use underscores for spaces (e.g., `Gabriel_3`). Written by backfill script, read by both WB M and dashboard.

### Firestore
- **`tickets`** — Water tickets submitted by drivers via WB T app
- **`invoices`** — Invoices for billing
- **`ticketBlocks`** — Ticket number block assignments
- **`invoiceBlocks`** — Invoice number block assignments
- **`operators`**, **`companies`**, **`wells`** — Reference data

### Deleted (Feb 18, 2026)
- **`wells/{wellName}/history/`** — Was redundant copy of `packets/processed`. Deleted.

### Data Flow
1. Mobile app sends pull → `packets/incoming/{packetId}`
2. Cloud Function `processIncomingPull` triggers, calculates everything, writes to:
   - `wells/{wellName}/status` (current state)
   - `packets/processed/{packetId}` (pull archive — THE history source of truth)
   - `packets/outgoing/{wellName}` (latest status, one per well — dashboard reads this)
3. Dashboard home/mobile page reads `packets/outgoing/{wellName}` for all wells → renders table/cards
4. Dashboard well detail page reads ALL of `packets/processed`, filters by well name → renders pull history
5. Performance pages read `performance/` cache → renders accuracy stats with drill-down

## Key Files

### Dashboard (src/)
- **`src/lib/tabs.ts`** — Tab definitions and `getActiveTab()` routing
- **`src/lib/wells.ts`** — Firebase RTDB data fetching. Key functions:
  - `fetchAllWellStatuses()` — Reads `packets/outgoing` for home/mobile page
  - `fetchWellHistoryUnified()` — Reads `packets/processed`, filters by well
  - `fetchWellPerformance()` — Reads `performance/{name}/rows` (uses underscore keys)
  - `fetchAllPerformanceData()` — Bulk reads entire `performance/` node
  - `buildPerformanceSummary()` — Builds route/well stats with anomaly detection
  - `processPerformanceRows()` — Anomaly detection (30% threshold from median deviation)
  - `calcWellStats()` — Calculates avg accuracy using `getRealAccuracy()` (matches WB M)
  - `calculateAccuracy()`, `getAccuracyColor()`, `getRealAccuracy()`, `formatLevel()`
- **`src/lib/tickets.ts`** — Firestore ticket fetching
- **`src/lib/invoices.ts`** — Firestore invoice fetching with status colors
- **`src/lib/firebase.ts`** — Firebase SDK init (RTDB + Firestore)
- **`src/components/AppHeader.tsx`** — Shared header with tab navigation
- **`src/components/SubHeader.tsx`** — Sub-page header with back button
- **`src/contexts/AuthContext.tsx`** — Auth provider (user.email, user.role, signOut)

### Pages
- `src/app/page.tsx` — Home overview with module summary cards
- `src/app/mobile/page.tsx` — WB Mobile well status (table/card views, grouped by route)
- `src/app/well/[wellName]/page.tsx` — Well detail with pull history, edit/delete
- `src/app/performance/page.tsx` — Performance overview (route cards)
- `src/app/performance/[route]/page.tsx` — Route performance (well list with sort)
- `src/app/performance/well/[wellName]/page.tsx` — Well performance detail (pull history table: date, pred, actual, accuracy%)
- `src/app/tickets/page.tsx` — WB Tickets table with search
- `src/app/billing/page.tsx` — WB Billing invoice table with status filter
- `src/app/payroll/page.tsx` — WB Payroll placeholder
- `src/app/admin/page.tsx` — Admin: add/edit/delete wells, NDIC picker
- `src/app/login/page.tsx` — Auth login page

### Cloud Functions (functions/src/)
- `functions/src/index.ts` — All Cloud Functions:
  - `processIncomingPull` (V1 RTDB trigger) — Main processor
  - `processEditRequest` (V1 RTDB trigger) — Pull edits from dashboard
  - `processDeleteRequest` (V1 RTDB trigger) — Pull deletes from dashboard
  - `watchdogStrandedPackets` (V2 scheduled, every 5 min)
  - `healthCheck` (V2 scheduled, every 10 min)

## Performance System

### Accuracy Calculation
- **Raw accuracy:** `predicted / actual * 100` (100% = perfect, 115% = over-predicted)
- **Real accuracy:** `100 - Math.abs(100 - raw)` — treats over/under equally. Used for all displayed averages.
- **Color bands:** Green (≤5% off), Yellow (≤10% off), Red (>10% off)

### Anomaly Detection (Performance)
- Threshold: 30% off from median deviation
- Calculate deviation from 100% for each row
- Find median deviation, mark rows > median + 30 as anomalies
- Anomalies excluded from averages but shown in detail view (gray/dimmed, 😕 emoji)
- Matches WB Mobile's `filterPerformanceAnomalies()` exactly

### Performance Data Keys
- Firebase uses **underscores** for spaces: `performance/Gabriel_3/rows/`
- `fetchWellPerformance()` converts well name with `replace(/\s/g, '_')`
- Each row: `{d: "2025-01-15", a: 89, p: 92}` (date, actual inches, predicted inches)
- Predicted values calculated by backfill script using previous pull's flow rate

### Anomaly Detection (Pull History)
- **Gold row** = Anomaly (excluded from AFR). Flow rate deviates significantly from median.
- **Gray row** = IT Review (1.5x off). Moderate deviation — needs human review.
- Progressive detection: each row compared against median of PREVIOUS rows only.

## Related Repos
- **WB Mobile app:** `C:\WellBuiltMobile` (React Native/Expo, builds APK via `eas build`)
- **WB Tickets app:** `C:\dev\waterticket-app` (React Native, Firestore + RTDB)

## Field Name Compatibility
Dashboard and Cloud Functions check BOTH field names for backward compatibility:
- `tanks` OR `numTanks`
- `bottomLevel` OR `allowedBottom`
Admin page writes BOTH when saving well config.

## Commands
```bash
# Dashboard development
cd C:\wellbuilt-dashboard
npm run dev                    # Dev server (port 3000)
npm run build && npm start     # Production mode

# Deploy dashboard (web only — no APK/IPA needed)
cd C:\wellbuilt-dashboard
npm run build && npx firebase deploy --only hosting

# Deploy Cloud Functions
cd C:\wellbuilt-dashboard\functions
npm run build && cd .. && npx firebase deploy --only functions

# Deploy both
cd C:\wellbuilt-dashboard
npm run build && npx firebase deploy

# Deploy Firestore rules (from WB T repo)
cd C:\dev\waterticket-app
npx firebase deploy --only firestore:rules

# Build mobile app APK
cd C:\WellBuiltMobile
eas build -p android --profile preview
```

## Gotchas
- **`packets/processed` is THE pull history source of truth.** `wells/{name}/history` was deleted.
- **`packets/outgoing` is the dashboard's primary status source.** Not `wells/{name}/status` (stale).
- **Performance keys use underscores:** `Gabriel_3` not `Gabriel 3` or `Gabriel3`.
- **Real accuracy for averages:** Always use `getRealAccuracy()` for displayed averages — matches WB M.
- **Cloud Functions `--force` flag:** Needed if deploying after adding/removing function exports.
- **Flow rate calc:** AFR = 5-pull rolling average of flow rates (days per foot of rise).
- **Tank-after calculation:** `tankAfterInches = tankTopInches - (bblsTaken / 20 / tanks) * 12`
- **`fetchWellHistoryUnified()` loads ALL of `packets/processed`** — filters client-side. Could be slow as data grows.
- **Dashboard SSR:** Uses Firebase Frameworks integration (Cloud Run). `next.config.ts` has SSR config.
- **Firestore rules:** Tickets/invoices read rules are in `C:\dev\waterticket-app\firestore.rules`, not this repo.
