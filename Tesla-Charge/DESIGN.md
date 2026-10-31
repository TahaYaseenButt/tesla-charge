---
name: "Tesla-Charge EV Station Design System"
version: "1.0.0"
platform: "mobile-first"
framework: "React Native / Expo Router"
author: "Tesla-Charge Team"
colors:
  primary: "#0F172A"       # Deep Slate (Headings, primary typography, high-contrast actions)
  primary-light: "#1E293B" # Card borders, dark badges
  secondary: "#475569"     # Slate neutral (subtitles, secondary text, metadata)
  tertiary: "#94A3B8"      # Light slate (disabled states, subtle dividers)
  surface: "#FFFFFF"       # Pure white foundation
  surface-alt: "#F8FAFC"   # Soft neutral tint for cards, input fields, and pill backgrounds
  border: "#E2E8F0"        # Standard crisp divider / card border
  border-subtle: "#F1F5F9" # Light container separation

  # Brand & Accent Tokens
  accent-blue: "#0284C7"   # Sky blue (charging in-progress, sync actions, links)
  accent-blue-bg: "#E0F2FE"# Soft blue pill background
  accent-blue-border: "#BAE6FD"

  # Hardware EV Status Colors
  status-available: "#10B981" # Emerald Green (Standby / Cable ready)
  status-available-bg: "#D1FAE5"
  status-charging: "#0284C7"  # Electric Blue (Active energy delivery)
  status-charging-bg: "#E0F2FE"
  status-preparing: "#F59E0B" # Amber Yellow (Car plugged in, handshake in progress)
  status-preparing-bg: "#FEF3C7"
  status-suspended: "#8B5CF6" # Violet (Suspended EV / EVSE waiting)
  status-suspended-bg: "#EDE9FE"
  status-faulted: "#EF4444"   # Coral Red (Ground failure, cable error, emergency stop)
  status-faulted-bg: "#FEE2E2"

typography:
  fontFamily: "System (-apple-system, SF Pro Display, Roboto, Inter, sans-serif)"
  hero-display:
    fontSize: "44px"
    fontWeight: "900"
    letterSpacing: "-1px"
    lineHeight: "48px"
  h1:
    fontSize: "24px"
    fontWeight: "800"
    letterSpacing: "-0.5px"
    lineHeight: "30px"
  h2:
    fontSize: "20px"
    fontWeight: "800"
    letterSpacing: "0px"
    lineHeight: "26px"
  h3:
    fontSize: "16px"
    fontWeight: "700"
    lineHeight: "22px"
  body-lg:
    fontSize: "15px"
    fontWeight: "500"
    lineHeight: "22px"
  body-md:
    fontSize: "13px"
    fontWeight: "500"
    lineHeight: "18px"
  body-sm:
    fontSize: "11px"
    fontWeight: "600"
    lineHeight: "15px"
  label-caps:
    fontSize: "10px"
    fontWeight: "800"
    letterSpacing: "1px"
    textTransform: "uppercase"

rounded:
  xs: "6px"
  sm: "10px"
  md: "14px"
  lg: "20px"
  xl: "28px"
  full: "9999px"

spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "48px"

shadows:
  subtle: "0 1px 3px rgba(15, 23, 42, 0.06), 0 1px 2px rgba(15, 23, 42, 0.04)"
  card: "0 4px 6px -1px rgba(15, 23, 42, 0.07), 0 2px 4px -2px rgba(15, 23, 42, 0.05)"
  elevated: "0 10px 15px -3px rgba(15, 23, 42, 0.08), 0 4px 6px -4px rgba(15, 23, 42, 0.04)"
---

# Google Stitch UI Specification: Tesla-Charge

## 1. Design Vision & Philosophy
Tesla-Charge merges **industrial precision with Apple-grade minimalism**. It is an ultra-clean, data-dense interface designed for fast physical scanning in direct sunlight, high-voltage equipment monitoring, and frictionless EV operations.

### Core Principles
1. **Zero-Latency Visual Feedback:** Car connection states (Idle, Gun A connected, Gun B connected, Dual-cable connected) transition instantly with photorealistic renders and reactive status pills.
2. **Local-First Speed:** Cached telemetry loads in 0ms from user local storage (`AsyncStorage`) with zero initial network spin.
3. **Hybrid Transport Optimization:** High-frequency live meter streams route through lightweight WebSockets (Realtime Database), while financial transactions and hardware identities live securely in Cloud Firestore.
4. **Glanceable Telemetry:** Power (kW), Voltage (V), Current (A), and Energy (kWh) are rendered in a crisp 3-column metric layout anchored by an oversized hero power readout.

---

## 2. Multi-Screen UI Architecture & Flows

### Screen 1: Admin Authentication (`/login`)
* **Purpose:** Station operator / driver authorization barrier.
* **Layout Structure:**
  - **Brand Header:** Lightning bolt monogram inside a rounded slate badge with `TESLA CHARGE` uppercase brand typography and sub-label `Station Management Terminal`.
  - **Identifier Input:** Station ID selector (defaults to `charger1`) with auto-sync indicator.
  - **Credentials Group:** Username (`admin`) and Password (`•••••`) styled as floating border inputs with inset focus states.
  - **CTA:** Full-width deep slate button with subtle glow and instant credentials verification.
  - **Smart Routing:** On successful submit, the screen queries Firestore. If the station has already been configured by any operator, it routes directly to `/(tabs)`. If unconfigured, it seamlessly opens the 2-step Setup Wizard.

### Screen 2: 2-Step Station Setup Wizard (`/setup`)
* **Purpose:** Initial hardware commissioning and GPS geo-tagging.
* **Top Navigation:** Unconditional `← Dashboard` back button allowing operators to exit setup without overwriting existing settings.
* **Step 1: Hardware Model Selection:**
  - Interactive grid cards for charger models (`AC_ThreePhase21KW`, `Solar EVX`, `CCS DC Fast 50kW`, `Dual Gun Commercial`).
  - Active card features a 2px slate border, emerald checkmark badge, and photorealistic hardware preview.
* **Step 2: Station ID & Location Permission:**
  - Station ID verification input.
  - Native GPS location permission button (`📍 Acquire Station Coordinates`).
  - GPS status pill showing latitude, longitude, and accuracy radius.
  - Primary Action: `Complete & Save Configuration` (dual-writes to Firestore and local storage).

### Screen 3: Live Dashboard Screen (`/(tabs)/index`)
* **Header Area:**
  - Left: Bold uppercase station identifier (`CHARGER1`).
  - Center-Left: Quick `⚙️ Setup` shortcut pill.
  - Right: Dual status pills:
    - Connector state badge (`• AVAILABLE`, `• PREPARING`, or `• CHARGING`).
    - Connectivity badge (`• ONLINE` in emerald or `• OFFLINE` in slate).
* **Center Visual Stage:**
  - Reactive EV illustration switching dynamically between:
    1. Standby Station (`state_idle.png`)
    2. Left Gun A connected (`state_left.png`)
    3. Right Gun B connected (`state_right.png`)
    4. Both Guns charging simultaneously (`state_both.png`)
* **Hero Telemetry:**
  - Giant `0.0 kW` live active power draw with unit label.
  - Dynamic connection sub-badge (`• GUN A PREPARING`, `• GUN B CHARGING`).
* **3-Column Metric Matrix:**
  - `VOLTAGE`: Phase average (e.g., `230 V`).
  - `CURRENT`: Phase draw (e.g., `0 A` or `32 A`).
  - `ENERGY`: Active session / cumulative delivered (e.g., `0.10 kWh`).
* **Bottom Floating Dock (`NativeTabs`):**
  - Pill-shaped frosted floating navigation bar with `Home`, `Test Lab`, and `History`.

### Screen 4: Charging History & Smart Calendar (`/(tabs)/history`)
* **Header Bar:**
  - Page title `CHARGING HISTORY` with `📅 Toggle Calendar` action.
  - **Offline/Sync Pill:** `💾 Local Storage (0 DB reads) • 8:56 PM` with quick `🔄 Sync Cloud` button.
* **Filter Segmented Control:**
  - 4 pill tabs: `Today` (default upfront), `Day`, `Range`, `Month`.
* **Collapsible Month Grid:**
  - Month navigation header (`‹ October 2026 ›`).
  - Day of week labels (`Sun`, `Mon`, `Tue`, `Wed`, `Thu`, `Fri`, `Sat`).
  - Interactive calendar cells showing date numbers with dot indicators for days containing energy sessions.
  - Selected day marked with deep slate circle fill.
* **Session Summary Header:**
  - Total filtered energy delivered (e.g., `14.8 kWh • 6 sessions`).
* **Transaction Cards List:**
  - Card Header: Gun Badge (`Gun A` / `Gun B`), Transaction ID (`#802257`), and Status Pill (`COMPLETED` in green or `IN PROGRESS` in blue).
  - Card Body: Energy delivered in bold (`0.00 kWh`), timestamp range (`12:13 PM → 12:14 PM (1 min)`), and authentication ID tag (`USER_QR_01` / `AppUser`).

### Screen 5: Hardware Test Lab (`/(tabs)/test`)
* **Purpose:** Hardware simulator for end-to-end event testing.
* **Section 1: Connectivity Simulation:**
  - Toggle Online / Offline with instant WebSocket notification.
* **Section 2: Dual Connector State Simulation:**
  - Independent status controllers for Gun A and Gun B (`Available`, `Preparing`, `Charging`, `Suspended`, `Faulted`).
  - Dual preset triggers: `⚡ Both Guns 22kW Charging` and `Standby Reset`.
* **Section 3: RFID Card Simulation:**
  - Custom RFID tag input (`RFID_TEST_01`) with programmatic swipe dispatcher.

---

## 3. Stitch Prompt Generation Guide

When prompting Google Stitch to recreate or extend screens in this app, use the following standardized prompt structure:

```text
Create a modern, Apple-inspired mobile EV charging interface for iOS in light mode.
Use the design system defined in DESIGN.md:
- Primary background is pure white (#FFFFFF) with #F8FAFC for card backgrounds and pills.
- Typography is clean system sans-serif with bold #0F172A headers.
- Hero power metric displayed as 44px bold text (e.g. '22.0 kW').
- Visual stage displays an EV car connected via a charging cable to a sleek teal EV charger kiosk.
- Metric cards use a 3-column split for Voltage (230 V), Current (32 A), and Energy (14.2 kWh).
- Status badges use pill shapes with colored dots: Emerald (#10B981) for Available/Online, Electric Blue (#0284C7) for Charging, and Amber (#F59E0B) for Preparing.
- Include a floating pill-shaped bottom tab bar with icons for Home, Test Lab, and History.
```

---

## 4. Component Token Mapping Table

| Component | Token / Property | Exact Value |
|---|---|---|
| Screen Background | `colors.surface` | `#FFFFFF` |
| Card Background | `colors.surface-alt` | `#F8FAFC` |
| Card Border | `colors.border` | `1px solid #E2E8F0` |
| Primary CTA Button | Fill: `#0F172A`, Text: `#FFFFFF` | Border-radius: `14px` (`rounded.md`) |
| Secondary Sync Button | Fill: `#E0F2FE`, Text: `#0284C7` | Border-radius: `8px` (`rounded.sm`) |
| Hero Power Value | `typography.hero-display` | `44px`, weight `900`, color `#0F172A` |
| Metric Sub-Label | `typography.label-caps` | `10px`, weight `800`, letter-spacing `1px`, color `#64748B` |
| Status Pill Online | Background: `#ECFDF5`, Dot: `#10B981` | Text: `ONLINE`, color `#047857` |
| Status Pill Preparing | Background: `#FEF3C7`, Dot: `#F59E0B` | Text: `PREPARING`, color `#B45309` |
| Status Pill Charging | Background: `#E0F2FE`, Dot: `#0284C7` | Text: `CHARGING`, color `#0369A1` |
| Active Tab Pill | Background: `#E2E8F0`, Shape: Capsule | `border-radius: 9999px` |
| Floating Tab Bar | Frosted pill dock | Background: `rgba(255, 255, 255, 0.95)`, Border: `#E2E8F0` |
