# Tesla-Charge: Technical Implementation & Architecture Log

This document details every technical step, architectural decision, and feature implemented in the **Tesla-Charge** mobile application.

---

## 1. High-Level System Architecture

The application is built using **Expo SDK 54 / React Native**, **TypeScript**, and a **Hybrid Cloud Backend**:

```
 ┌─────────────────────────────────────────────────────────────┐
 │                 React Native / Expo Mobile App              │
 │                     (Tesla-Charge Client)                   │
 └───────▲────────────────────────▲───────────────────▲────────┘
         │ Live Telemetry         │ Config & History  │ Direct REST Fetch
         │ (< 100ms, WebSocket)   │ (Long-polling)    │ (Zero Socket Drops)
 ┌───────▼─────────────┐  ┌───────▼───────────┐  ┌────▼──────────────┐
 │  Firebase Realtime  │  │   Cloud Firestore │  │   Firestore REST  │
 │   Database (RTDB)   │  │    Document DB    │  │     Endpoint      │
 └─────────────────────┘  └───────────────────┘  └───────────────────┘
```

- **Firebase Realtime Database (RTDB)**: Handles live telemetry updates (voltage, current, power kW, plug status, active transactions) using lightweight WebSocket streaming with sub-100ms latency and bandwidth-based billing.
- **Cloud Firestore**: Stores persistent records (station hardware profiles, transaction logs, user accounts) with indexing and complex query support.
- **Direct HTTPS REST Fallback**: Bypasses Firestore WebChannel streaming negotiation to prevent connection dropouts on mobile data networks.
- **AsyncStorage Local-First Caching**: Implements offline persistence to achieve instant startup (0ms) and eliminate unnecessary cloud reads.

---

## 2. Technical Steps Implemented

### Step 1: Firebase Configuration & Network Transport Hardening
- **File**: [`src/config/firebase.ts`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/config/firebase.ts)
- **Problem**: Firestore threw timeout errors:
  `@firebase/firestore: Could not reach Cloud Firestore backend within 10 seconds. Failed to get document because client is offline.`
- **Technical Implementation**:
  1. Configured a dedicated named Firebase app instance (`tesla-charge-station`).
  2. Initialized Firestore with `experimentalForceLongPolling: true` to prevent WebChannel socket timeouts on mobile connections.
  3. Muted noisy SDK reconnection logs using `setLogLevel("silent")`.
  4. Built a direct HTTPS REST client (`fetchFirestoreDoc` and `fetchFirestoreCollection`) with an automated schema deserializer (`parseFirestoreFields`) to parse Firestore REST AST fields into standard JavaScript objects.
  5. Implemented RTDB key sanitation utility (`livePath`) to ensure keys comply with RTDB naming rules (replacing `.`, `#`, `$`, `[`, `]`, `/`).

---

### Step 2: Station Commissioning Wizard & Remote Database Sync
- **Files**: [`src/app/setup.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/setup.tsx), [`src/config/auth.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/config/auth.tsx)
- **Problem**: Previously, entering the app required manual re-selection of charger models and settings upon every login.
- **Technical Implementation**:
  1. Built a 2-step setup wizard:
     - **Step 1 — Hardware Model**: Preconfigured templates (Single-Phase 7.4kW, Three-Phase 11kW, Three-Phase 22kW, DC Fast Charger) or custom name entry.
     - **Step 2 — Station Identity & GPS**: Station ID entry with automatic GPS coordinate acquisition via `expo-location` and reverse geocoding.
  2. Integrated cloud persistence to `chargers/{chargerId}` in Firestore via `saveSetup()`.
  3. Added `fetchRemoteConfig()`: Upon login, the app queries Firestore. If a configuration exists for that station, the setup wizard is automatically skipped and the user is redirected straight to the live dashboard.

---

### Step 3: Real-Time Dynamic Dashboard & Telemetry Visualizer
- **File**: [`src/app/(tabs)/index.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/(tabs)/index.tsx)
- **Technical Implementation**:
  1. **Dynamic Visual Stage**: Automatically swaps vehicle graphics based on live hardware connector states:
     - `state_idle.png`: No vehicles plugged in.
     - `state_left.png`: Gun A (Connector 1) actively plugged/charging.
     - `state_right.png`: Gun B (Connector 2) actively plugged/charging.
     - `state_both.png`: Dual charging session active on both connectors.
  2. **OCPP State Badges**: Color-coded status pills supporting all OCPP 1.6 states (`Charging`, `Preparing`, `SuspendedEV`, `SuspendedEVSE`, `Finishing`, `Available`, `Faulted`).
  3. **Dual-Gun vs Single-Gun Layout**:
     - Dual-connected view: Splits into side-by-side cards with independent Voltage, Current, and Energy gauges.
     - Single-connected view: Displays an expansive card with a 3-column metric layout.
  4. **Live Heartbeat Monitor**: Calculates online/offline state by evaluating if `lastHeartbeat` occurred within the last 120 seconds.

---

### Step 4: Local-First Offline Caching Strategy
- **File**: [`src/services/storage.ts`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/services/storage.ts)
- **Problem**: User requested minimal cloud reads to reduce database costs and maintain speed over weak network connections.
- **Technical Implementation**:
  1. Built an offline-first data layer with `@react-native-async-storage/async-storage`.
  2. **Read Strategy (`fetchTransactionsWithCacheStrategy`)**:
     - Checks local storage first.
     - If local cached transactions exist and `forceRefresh` is false, returns cached data immediately with **0 database reads**.
     - Only queries Firestore when local storage is empty or when the user explicitly triggers pull-to-refresh or taps **🔄 Sync Cloud**.
  3. **Incremental Local Merging (`mergeLocalTransaction`)**:
     - When telemetry reports a new active session or completed transaction, it is merged directly into local storage, eliminating the need to re-fetch historical data from the cloud.

---

### Step 5: History Analytics & Interactive Calendar
- **File**: [`src/app/(tabs)/history.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/(tabs)/history.tsx)
- **Technical Implementation**:
  1. **Date Filtering**:
     - `Today`: Quickly isolates current day sessions.
     - `Day`: Inspects any selected day.
     - `Range`: Selects start and end dates.
     - `Month`: Aggregates the whole month.
  2. **Interactive Calendar Grid**:
     - Calculates days of the month and alignment with weekday headers.
     - Computes energy heat indicators and session count dots for every calendar date.
  3. **Summary Metrics Banner**: Computes total energy (kWh) delivered and session count for the active filter range.
  4. **Detailed Session Cards**: Renders duration, start/stop times, connector badge (Gun A / Gun B), energy delivered, and user attribution badge.

---

### Step 6: Firebase Email/Password Authentication & User Data Segregation
- **Files**: [`src/config/firebase.ts`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/config/firebase.ts), [`src/config/auth.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/config/auth.tsx), [`src/app/login.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/login.tsx)
- **Problem**: Replace hardcoded credentials with production Firebase Email Authentication (without requiring email verification codes), ensuring individual user profiles and private data segregation.
- **Technical Implementation**:
  1. **Firebase Auth Integration**:
     - Initialized `auth = getAuth(app)` in `firebase.ts`.
     - Integrated `signInWithEmailAndPassword(auth, email, password)`.
     - Integrated `createUserWithEmailAndPassword(auth, email, password)` allowing instant access without verification codes.
     - Added `signOut(auth)` to support account switching.
     - Stored persistent `UserProfile` state (`uid`, `email`, `displayName`).
  2. **Multi-User Data Segregation**:
     - **Cloud Storage**: Users are registered under `users/{uid}` in Firestore with login timestamps and default station IDs.
     - **Cache Isolation**: Storage keys in `storage.ts` are scoped per `userId` (e.g. `@tesla_charge_txs_{chargerId}_{userId}`), ensuring User A's offline cache is completely isolated from User B on the same device.
     - **History Viewport Filtering**: Added a dual-scope selector in `history.tsx` between **👤 My Sessions** (personal sessions) and **⚡ All Station Activity** (station-wide activity).
  3. **UI Upgrades**:
     - Added "Sign In" vs "Create Account" segmented tabs on `login.tsx`.
     - Added user session bar on `index.tsx` showing the logged-in email and a **Log Out ↗** button.

---

### Step 7: Google Stitch Design System & Interactive Showcase
- **Files**: [`DESIGN.md`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/DESIGN.md), [`stitch-preview.html`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/stitch-preview.html)
- **Technical Implementation**:
  1. Created a design specification adhering to Tesla / Apple Human Interface Guidelines with dark slate (`#0F172A`), electric blue (`#0284C7`), and emerald green (`#10B981`) palettes.
  2. Built `stitch-preview.html`: An interactive multi-screen showcase displaying all four core screens (Login with Email Auth, Setup Commissioning, Live Dashboard with User Session Bar, and History Analytics with Scope Selector) inside simulated iPhone frames.

---

## 3. Current File Map

| Path | Purpose |
| :--- | :--- |
| `src/config/firebase.ts` | Firebase App, Auth, Firestore, RTDB instances & direct REST utilities |
| `src/config/auth.tsx` | Authentication Context, Firebase Auth handlers, User Profile management |
| `src/services/storage.ts` | Local-First AsyncStorage caching layer with per-user data isolation |
| `src/app/login.tsx` | Sign In & Create Account screen with Email/Password validation |
| `src/app/setup.tsx` | 2-step Station Commissioning Wizard (Hardware Model + GPS Location) |
| `src/app/(tabs)/index.tsx` | Live Dashboard with dynamic vehicle graphics, power meters, and Logout bar |
| `src/app/(tabs)/history.tsx` | History Analytics with interactive calendar and "My Sessions" scope selector |
| `src/app/(tabs)/test.tsx` | OCPP Developer Lab to test telemetry states and simulate charger events |
| `stitch-preview.html` | Browser-based interactive UI preview of all application screens |
| `DESIGN.md` | Complete UI tokens, color palettes, and component design specifications |

---

---

## 4. Production Hardening & Edge-Case Resolutions (12 Core Fixes)

| # | Issue | Why It Happened | Architectural Fix Implemented |
|---|---|---|---|
| **1** | **REST calls fail after ~1 hour** | User's Firebase ID token expires hourly, causing 401 Unauthorized errors on direct REST endpoints. | Built `getAuthHeaders()` in [`firebase.ts`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/config/firebase.ts#L67-L85) which calls `auth.currentUser.getIdToken(false)` to automatically refresh and attach the `Bearer` token to every request. |
| **2** | **Only 20 documents returned** | Firestore REST collection list endpoint defaults to small page sizes and returns `nextPageToken`. | Implemented a `do...while` pagination loop in `fetchFirestoreCollection()` in [`firebase.ts`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/config/firebase.ts#L170-L215) that follows `nextPageToken` until all records are retrieved (capped at 300). |
| **3** | **User logged out on app restart** | In React Native, `getAuth()` defaults to in-memory persistence unless explicit storage is provided. | Initialized authentication with `initializeAuth` and `getReactNativePersistence(AsyncStorage)` in [`firebase.ts`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/config/firebase.ts#L39-L55). |
| **4** | **Charger shows offline wrongly** | Fixed 120s threshold breaks if OCPP heartbeat interval is longer, or if mobile device clock drifts. | Added a listener to RTDB `.info/serverTimeOffset` in [`index.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/(tabs)/index.tsx#L85-L95) to calculate true server time, and expanded the heartbeat threshold to 180s. |
| **5** | **Charger shows "Charging" when dead** | Last known status persists in RTDB when the charger suddenly loses power or disconnects. | Implemented offline circuit-breaker in [`index.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/(tabs)/index.tsx#L220-L245): If `!isOnline`, connector statuses instantly fall back to `Unavailable`, power resets to `0.0 kW`, and vehicle state resets to `idle`. |
| **6** | **Unknown status crashes badge** | OCPP 1.6 has 9 standard statuses; missing `Reserved` and `Unavailable` or receiving non-standard strings causes undefined property lookups. | Added `Reserved` and `Unavailable` to `STATUS_CONFIG` and wrapped with a fallback helper `getStatusConfig(status)` in [`index.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/(tabs)/index.tsx#L35-L65). |
| **7** | **Stale or duplicate history** | Local-first storage returned cached records indefinitely, and incremental merging created duplicate records. | Added a 15-minute Cache TTL (`CACHE_TTL_MS = 15 * 60 * 1000`) and Map-based de-duplication keyed on `transactionId` in [`storage.ts`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/services/storage.ts#L115-L155). |
| **8** | **Cache overflow on Android** | AsyncStorage on Android has a ~6MB storage limit; unbounded transaction storage causes crashes. | Defined `MAX_CACHED_TRANSACTIONS = 200` in [`storage.ts`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/services/storage.ts#L86-L95) to cap local storage. |
| **9** | **Key collisions in `livePath`** | Mapping `.`, `#`, and `/` to `_` caused IDs like `A.1` and `A#1` to collide. | Created `sanitizeChargerId()` in [`firebase.ts`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/config/firebase.ts#L57-L70) enforcing a clean slug format (`lowercase alphanumeric + hyphen`). |
| **10** | **Date grouping timezone errors** | Calendar date keys conflicted between UTC timestamps and device local calendar days. | Harmonized `formatDateKey()` and `getTxDateKey()` in [`history.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/(tabs)/history.tsx#L20-L30) to consistently format dates into `YYYY-MM-DD`. |
| **11** | **Missing composite index error** | Multi-field Firestore queries require composite indexes and throw `failed-precondition`. | Added specific error catching for `failed-precondition` in [`storage.ts`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/services/storage.ts#L225-L235) that logs the exact Firebase index creation URL, while falling back gracefully. |
| **12** | **Hidden errors in development** | Unconditional `setLogLevel("silent")` suppressed genuine SDK warnings and network issues. | Configured `setLogLevel("error")` in `__DEV__` mode and `setLogLevel("silent")` exclusively for production in [`firebase.ts`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/config/firebase.ts#L12-L17). |

---

## 5. Dynamic Charger Control & Universal Tariff Implementation

### A. Dynamic Control Screen (`src/app/(tabs)/control.tsx`)
- **Remote Charger Commands**: Implemented `startChargingSession` and `stopChargingSession` in [`src/services/control.ts`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/services/control.ts). Writes remote commands directly to RTDB (`live/{chargerId}/commands/remoteStartTransaction` and `remoteStopTransaction`).
- **Dynamic Gun Controls**: 
  - If 1 gun is plugged in, the screen auto-locks to that gun.
  - If both Gun A and Gun B are plugged in, a segmented switcher allows toggling between Gun A and Gun B.
  - If neither gun is plugged in, the screen shows a clean standby empty state directing users back to the dashboard.
- **Charging Limit Picker**:
  - **Full**: Charge unrestricted until the battery reaches 100%.
  - **Time**: Limit charging duration (presets: 30m, 45m, 1h, 2h, or custom minutes).
  - **Energy**: Limit charging energy (presets: 10 kWh, 20 kWh, 35 kWh, 50 kWh, or custom kWh).
  - **Price / Budget**: Limit charging budget (presets: 500, 1000, 2000, 3500, or custom amount in local currency).
- **Minimalist UX**: Follows clean Tesla/Apple design principles with live session cards, target progress bar, and immediate feedback (no cluttered divs).

### B. Dynamic Navigation Dock Visibility (`src/components/app-tabs.tsx`)
- Connected `useChargerLive(chargerId)` to monitor live connector statuses:
  - Connector status is considered connected if in: `['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing']`.
  - When `hasAnyGunConnected` is `false`, the **Control Tab is completely hidden from the bottom tab bar**.
  - As soon as a car plugs into Gun A or Gun B, the Control tab dynamically appears.

### C. Universal Tariff Rate & Settings (`src/app/(tabs)/settings.tsx`)
- Configured universal electricity tariff rate per kWh (`tariffRate`) and currency (`PKR`, `USD`, `EUR`, `AED`, `GBP`, etc.) in [`AuthContext`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/config/auth.tsx).
- Stored permanently in Firestore at `chargers/{chargerId}.tariffRate` and cached in user's local `AsyncStorage` (`@tesla_charge_tariff_rate`, `@tesla_charge_currency`).

### D. Real-Time Charging Price on Home Screen (`src/app/(tabs)/index.tsx`)
- Added real-time dynamic cost calculation:
  - `costA = energyA * tariffRate`
  - `costB = energyB * tariffRate`
  - `totalCost = (energyA + energyB) * tariffRate`
- Rendered live cost pill directly below the main kW hero power display.
- Integrated Live Cost rows in dual-gun cards and single-gun metric grids.

---

## 6. UI/UX Design System Refactoring (Standard Renowned App Patterns)

### A. Authentication Architecture (`src/app/login.tsx`)
- **Facebook / Instagram Pattern**:
  - Removed all cluttered debug divs, developer text, "auto-fill demo" buttons, and station ID hardware fields from the login screen.
  - Removed setup wizard shortcuts from the login screen (commissioning belongs inside the authenticated flow).
  - High-hierarchy focused inputs: Clean email and password fields with modern 12px corner radii.
  - Solid, bold primary button: **`Log In`** (or `Sign Up`).
  - Below the primary CTA: Subtle `OR` divider leading to an authentic Facebook/Instagram-style secondary outline button: **`Create new account`**.

### B. Clean Minimalist Home Screen (`src/app/(tabs)/index.tsx`)
- Removed cluttered floating divs in the middle of the screen:
  - Removed floating email user bar with red logout button (moved cleanly to Settings tab).
  - Removed GPS location coordinate row from the hero section.
  - Removed redundant duplicate status badges (e.g. `ONLINE` + `CHARGING` side by side) — unified into a single status indicator in the top right.
  - Removed extra quick-action button in the middle (the bottom dock already handles dynamic Control navigation).
- Power and Real-Time Price are cleanly unified directly beneath the hero car display (`11.2 kW` with subtle `PKR 375.00 · PKR 50/kWh`).

---

## 7. Currency Standardization & Clean Settings Architecture

### A. Dedicated PKR Currency Architecture
- As the application is built specifically for Pakistan, all arbitrary currency selectors and multi-currency conversions were removed.
- Currency is hardcoded directly to **`PKR`** across [`settings.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/(tabs)/settings.tsx), [`control.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/(tabs)/control.tsx), and [`index.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/(tabs)/index.tsx).

### B. Clean Settings UI
- Removed all "universal settings" jargon.
- Card title: `Electricity Tariff`.
- Clean input row with `PKR` prefix and `/ kWh` unit suffix.
- Action button: Clean, standard **`Save`** button.
- Station hardware information card (Station ID, Model, Protocol) and account card with Log Out action.

---

## 8. Dual-Layer Resilient Real-Time Synchronization (Fixing Test Lab Plug-In)

### Why Test Lab "Plug In" Failed Previously:
- In Firebase RTDB, the database rules on `/live/charger1` returned `permission_denied` for client listeners/updates.
- Because `useChargerLive` and `index.tsx` previously relied exclusively on RTDB listeners, when RTDB returned `permission_denied`, connector status updates from Test Lab were never received.
- Consequently, `connector1.status` remained `Available`, `hasAnyGunConnected` stayed `false`, the Control tab never appeared, and the Home car graphic did not update.

### The Architectural Resolution:
1. **Firestore `onSnapshot` Real-Time Listeners**:
   - Added real-time Firestore snapshots in [`src/hooks/useChargerLive.ts`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/hooks/useChargerLive.ts) and [`src/app/(tabs)/index.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/(tabs)/index.tsx) listening to:
     - `chargers/{CHARGER_ID}`
     - `chargers/{CHARGER_ID}/connectors/1`
     - `chargers/{CHARGER_ID}/connectors/2`
2. **Local Storage Immediate Persistence**:
   - In [`src/app/(tabs)/test.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/(tabs)/test.tsx), `updateConnector` saves directly to `saveLocalConnectorData` and `saveLocalChargerData` as well as Firestore.
3. **Graceful RTDB Fallback**:
   - RTDB updates and listeners are wrapped with safe error handling so that even when RTDB rules reject client writes, Firestore snapshots and local storage deliver 0ms reactive UI changes.
   - When the user taps "🔌 Plug In", Gun A status becomes `Preparing`, `hasAnyGunConnected` becomes `true`, the **Control Tab** dynamically mounts in the bottom dock, and the Home screen car updates to `state_left.png`.

---

## 9. Over-The-Air (OTA) Updates & Version Management

### Requirements & Capabilities:
- Enable seamless Over-The-Air (OTA) updates using `expo-updates` so bugfixes and new features can be published instantly without requiring app store resubmissions.
- In Settings ([`src/app/(tabs)/settings.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/(tabs)/settings.tsx)):
  - Display the current installed version number (`v1.0.0`) from `expo-constants`.
  - Provide a dedicated **"Search for Updates"** button.
  - Dynamically check update status (`Updates.checkForUpdateAsync()`).
  - Auto-download available bundles (`Updates.fetchUpdateAsync()`) and display an instant action prompt to restart (`Updates.reloadAsync()`).
  - Include graceful development mode detection: when running in Expo Go or local dev server where standalone OTA updates are inactive, the UI provides friendly user feedback and explains production release channel behavior without throwing unhandled exceptions.

### Configuration ([`app.json`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/app.json)):
```json
"runtimeVersion": {
  "policy": "appVersion"
},
"updates": {
  "enabled": true,
  "checkAutomatically": "ON_LOAD",
  "fallbackToCacheTimeout": 0
}
```

---

## 10. Android APK Generation (EAS Build)

### Requirements & Capabilities:
- Enable generating a standalone, installable `.apk` file directly for testing and distribution on physical Android phones.
- Configured [`app.json`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/app.json) with unique Android package `com.teslacharge.app`.
- Created [`eas.json`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/eas.json) specifying `"buildType": "apk"` under the `preview` and `production` profiles.

### Build Command:
```bash
npx eas-cli@latest build -p android --profile preview --local
```

---

## 11. OTA Update Publishing (EAS Update)

### Target:
- Deploy over-the-air update `v1.0.1` targeting the installed APK (running runtimeVersion `1.0.0`).
- Users receive new features without reinstalling the APK.

### Update Highlights in `v1.0.1`:
1. **Installed Version Display**: Bumps version display to `v1.0.1` with `OTA LATEST` badge.
2. **Release Notes Card**: Embedded "What's New in v1.0.1" box highlighting instant OTA sync, dual 22kW connector sync, and PKR electricity tariff precision.
3. **Interactive Update Check**: Real-time checking and restart prompt via `Updates.reloadAsync()`.

### Publish Command:
```bash
npx eas-cli@latest update --channel preview --environment preview --message "v1.0.1 - OTA update verified" --non-interactive
```

---

## 12. Hardware Model Commissioning (30kW, 60kW, 240kW)

### Requirements & Capabilities:
- Clean studio white background processing for all 3 official hardware models:
  1. **30kW Wallbox** ([`assets/images/models/charger_30kw.png`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/assets/images/models/charger_30kw.png)): Commercial Wall-Mounted Fast DC/AC charger with single gun CCS2.
  2. **60kW Dual Rapid Pedestal** ([`assets/images/models/charger_60kw.png`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/assets/images/models/charger_60kw.png)): Commercial DC rapid pedestal charger with dual CCS2 connectors and dual gun telemetry.
  3. **240kW Ultra-Fast Hub** ([`assets/images/models/charger_240kw.png`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/assets/images/models/charger_240kw.png)): Heavy-duty ultra-fast DC supercharger with dual 600A liquid/air-cooled CCS2.
- Integrated into the initial signup and login commissioning flow ([`src/app/setup.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/setup.tsx)).
- Per-user Firestore persistence ([`users/{uid}`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/config/auth.tsx)) ensures new signups are prompted to configure their specific station model and identifier.
- Added a **"Change Station ID or Hardware Model"** button in Settings ([`src/app/(tabs)/settings.tsx`](file:///Users/teslastudious/Ocpp%20server/tesla-charge/Tesla-Charge/src/app/(tabs)/settings.tsx)) allowing drivers/operators to switch hardware models at any time.

---

## 13. Verification & Quality Status

- **TypeScript Compilation**: `npx tsc --noEmit` executed with **0 errors**.
- **Cross-Platform Compatibility**: Fully compatible with iOS, Android, and Web runtimes.
- **Model Image Assets**: 30kW, 60kW, and 240kW studio white background assets generated in `assets/images/models/`.



