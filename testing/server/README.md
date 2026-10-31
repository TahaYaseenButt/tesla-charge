# T-Charge | OCPP 1.6-J & Firebase Gateway

A clean, high-performance, and lightweight OCPP 1.6-J central server that connects directly to **Firebase Firestore & Realtime Database**.

---

## 🚀 Quick Start (Two Ways to Run)

### Method 1: Production Docker Container (Recommended for 24/7 Raspberry Pi)
```bash
# 1. From the ocpp-firebase-server directory:
docker compose up -d

# 2. View live logs:
docker compose logs -f

# 3. Stop or restart:
docker compose down
docker compose restart
```

### Method 2: Native Node.js
```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
```

Once started:
- **Dashboard**: Open `http://localhost:3000` (or `http://<LINUX_IP>:3000`)
- **OCPP URL for Chargers**: `ws://<LINUX_IP>:3000/api/ocpp/version/1.6`

---

## 🔌 Connecting your EV Charger (OCPP 1.6-J)

In your charger's network / OCPP settings:

### Option A: Encrypted (Recommended)
- **Server URL**: `wss://tesla-charge.online/api/ocpp/version/1.6`
- **Port**: `443` (Default for WSS, do NOT enter 3000)
- **Charge Point ID / Identifier**: `charger1` (or whatever ID you choose)

### Option B: Plain WebSockets (If charger hardware has no SSL / TLS)
- **Server URL**: `ws://tesla-charge.online/api/ocpp/version/1.6`
- **Port**: `80` (Default for WS, do NOT enter 3000)
- **Charge Point ID / Identifier**: `charger1`

> ⚠️ **Important**: Do **NOT** use port `3000` with `tesla-charge.online`. Traffic is routed through Cloudflare, which only proxies standard web ports (80 / 443). Using `:3000` over the domain will result in a connection timeout.

Once saved and connected, the charger will show as **Online** on the dashboard and in Firebase!

---

## 🔥 Firestore Collections (For your React Mobile App)

Your React mobile app can connect directly to Firestore (`fir-85543`) using standard Firebase hooks:

### 1. `chargers/{chargePointId}`
Contains charger status, model, vendor, and live connector states:
```json
{
  "chargePointId": "charger01",
  "vendor": "Voltronic",
  "model": "EVA",
  "status": "Online",
  "lastHeartbeat": "2026-10-22T22:30:00Z",
  "connector_1_status": "Available"
}
```

### 2. `chargers/{chargePointId}/connectors/{connectorId}`
Real-time live telemetry during charging:
```json
{
  "connectorId": 1,
  "status": "Charging",
  "telemetry": {
    "powerKw": 7.2,
    "voltage": 230.5,
    "currentL1": 31.4,
    "energyWh": 15400,
    "soc": 65
  }
}
```

### 3. `transactions/{transactionId}`
Stores charging history and billing:
```json
{
  "transactionId": 101,
  "chargePointId": "charger01",
  "connectorId": 1,
  "startTime": "2026-10-22T20:00:00Z",
  "stopTime": "2026-10-22T21:30:00Z",
  "energyDeliveredKwh": 15.4,
  "cost": 4.62,
  "status": "Completed",
  "paymentStatus": "Paid",
  "paid": true
}
```

---

## 📱 How your React Mobile App Controls the Charger

To unlock a cable or stop charging, your React mobile app simply adds a document to the `commands` collection in Firestore:

```javascript
import { collection, addDoc } from "firebase/firestore";

// To Unlock Cable:
await addDoc(collection(db, "commands"), {
  chargePointId: "charger01",
  action: "UnlockConnector",
  connectorId: 1,
  status: "pending"
});

// To Remote Stop:
await addDoc(collection(db, "commands"), {
  chargePointId: "charger01",
  action: "RemoteStopTransaction",
  transactionId: 101,
  status: "pending"
});
```

The server automatically picks up this command, sends the OCPP command to the Voltronic charger, and updates `status: "completed"`.

---

## 🏦 Bank Payment Webhook (Automatic Unplug)

When a customer pays via the Bank QR code, the bank API calls:

```http
POST /api/payment-webhook
Content-Type: application/json

{
  "transactionId": 101,
  "chargePointId": "charger01",
  "connectorId": 1,
  "amount": 4.62,
  "status": "SUCCESS",
  "bankReference": "BANK_REF_123"
}
```

The server marks the transaction as **Paid** and **automatically sends `UnlockConnector`** so the driver can unplug immediately!
