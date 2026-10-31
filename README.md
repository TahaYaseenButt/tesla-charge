# Tesla Charge Project

This repository contains the complete ecosystem for the **Tesla Charge** EV charging system:

```
tesla-charge/
├── Tesla-Charge/           # 📱 React Native / Expo Mobile App (iOS & Android)
├── ocpp-firebase-server/   # ⚡ Lightweight OCPP 1.6-J & Firebase Central Server (Hosted on Raspberry Pi)
└── legacy-ocpp-manager/    # 📦 Archived legacy Docker/PostgreSQL ocpp-manager codebase
```

---

## 📱 1. Mobile App (`Tesla-Charge/`)
* **Stack**: Expo SDK 54, React Native, TypeScript.
* **Features**: Live power telemetry, dual connector support (Gun A / Gun B), active session monitoring, history analytics with interactive calendar, and remote charging controls (Start, Stop, and Cable Unlock).
* **Backend Connection**: Direct real-time connection to Firebase (Firestore & Realtime Database).

---

## ⚡ 2. Central Server (`ocpp-firebase-server/`)
* **Stack**: Node.js, Express, WebSocket (`ws`), Firebase Admin SDK.
* **Deployment Target**: Raspberry Pi system running Debian / Raspberry Pi OS.
* **Role**:
  * Acts as the OCPP 1.6-J Central System for physical EV chargers.
  * Streams real-time telemetry, connector states, and meter readings to Firebase RTDB.
  * Writes transaction history to Firestore.
  * Listens in real time for remote commands (Start, Stop, Unlock) initiated by the mobile app.

---

## 📦 3. Archived Files (`legacy-ocpp-manager/`)
Contains the original open-source `ocpp-manager` Docker Compose, PostgreSQL database configuration, HonoJS `api`, and SvelteKit `app` templates preserved for reference.
