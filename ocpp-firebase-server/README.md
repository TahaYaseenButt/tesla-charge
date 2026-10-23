# T-Charge | OCPP 1.6-J & Firebase Gateway

A clean, high-performance, and lightweight OCPP 1.6-J central server that connects directly to **Firebase Firestore** without any SQL/PostgreSQL or Docker requirements.

---

## 🚀 Quick Start

From the `ocpp-firebase-server` folder:

```bash
# 1. Install dependencies (already done)
npm install

# 2. Start the server
npm start
```

Once started:
- **Dashboard**: Open `http://localhost:3000` in your browser.
- **OCPP URL for Chargers**: `ws://tcharge.duckdns.org:3000/api/ocpp/version/1.6`

---

## 🔌 Connecting your Voltronic EV Charger

In your Voltronic charger's settings:
- **OCPP Server URL**: `ws://tcharge.duckdns.org:3000/api/ocpp/version/1.6`
- **Identifier**: `charger01` (or whatever ID you choose)

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
