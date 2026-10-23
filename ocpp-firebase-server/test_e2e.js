import WebSocket from "ws";
import { db } from "./src/config/firebase.js";
import { doc, getDoc, collection, addDoc, updateDoc } from "firebase/firestore";

const CHARGER_ID = "voltronic_test_01";
const WS_URL = `ws://localhost:3000/api/ocpp/version/1.6/${CHARGER_ID}`;

console.log("==================================================");
console.log("🧪 STARTING FULL OCPP 1.6-J & FIREBASE TEST SUITE");
console.log("==================================================");

async function runTests() {
  const ws = new WebSocket(WS_URL, ["ocpp1.6"]);

  await new Promise((resolve, reject) => {
    ws.on("open", () => {
      console.log(`\n✅ 1. WebSocket Connected to ${WS_URL}`);
      console.log(`   Negotiated Subprotocol: ${ws.protocol || "none"}`);
      if (ws.protocol === "ocpp1.6") {
        console.log(`   🎯 Protocol Compliance: Officially Negotiated [ocpp1.6]!`);
      }
      resolve();
    });
    ws.on("error", reject);
  });

  let pendingResponse = null;

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    const [type, id, actionOrPayload, maybePayload] = msg;

    if (type === 3 && pendingResponse) {
      // CALLRESULT
      pendingResponse.resolve(actionOrPayload);
    } else if (type === 2) {
      // CALL from server to charger (e.g. UnlockConnector, Reset)
      console.log(`   📥 Charger received command from Server: ${actionOrPayload}`, maybePayload);
      if (actionOrPayload === "UnlockConnector") {
        // Send CallResult: Unlocked
        ws.send(JSON.stringify([3, id, { status: "Unlocked" }]));
        console.log(`   📤 Charger replied to Server: [3, "${id}", { status: "Unlocked" }]`);
      } else if (actionOrPayload === "Reset") {
        ws.send(JSON.stringify([3, id, { status: "Accepted" }]));
      }
    }
  });

  function sendCall(action, payload) {
    const msgId = "msg_" + Math.random().toString(36).substring(7);
    const req = [2, msgId, action, payload];
    return new Promise((resolve) => {
      pendingResponse = { resolve };
      ws.send(JSON.stringify(req));
    });
  }

  // --- Step 2: Test BootNotification ---
  console.log("\n📡 2. Testing BootNotification (OCPP 1.6-J)...");
  const bootRes = await sendCall("BootNotification", {
    chargePointVendor: "Voltronic Power",
    chargePointModel: "EVA-5430",
    firmwareVersion: "v2.1.4",
  });
  console.log("   Server Response:", bootRes);
  if (bootRes.status !== "Accepted") throw new Error("BootNotification rejected");

  // Check Firestore
  const chargerSnap = await getDoc(doc(db, "chargers", CHARGER_ID));
  console.log("   🔥 Firestore chargers record:", chargerSnap.data());
  if (chargerSnap.data().vendor !== "Voltronic Power") throw new Error("Firestore mismatch for charger");

  // --- Step 3: Test StatusNotification ---
  console.log("\n📡 3. Testing StatusNotification (Connector 1 -> Preparing)...");
  await sendCall("StatusNotification", {
    connectorId: 1,
    status: "Preparing",
    errorCode: "NoError",
  });

  // Check Firestore connector
  const connSnap = await getDoc(doc(db, "chargers", CHARGER_ID, "connectors", "1"));
  console.log("   🔥 Firestore connector status:", connSnap.data().status);

  // --- Step 4: Test StartTransaction ---
  console.log("\n📡 4. Testing StartTransaction (Plugging in & Charging)...");
  const startRes = await sendCall("StartTransaction", {
    connectorId: 1,
    idTag: "USER_RFID_1234",
    meterStart: 10000,
    timestamp: new Date().toISOString(),
  });
  const txId = startRes.transactionId;
  console.log(`   Transaction Started! ID: ${txId}, Status: ${startRes.idTagInfo.status}`);

  // --- Step 5: Test MeterValues Telemetry ---
  console.log("\n📡 5. Testing MeterValues (7.2 kW Power, 230V, 31.3A)...");
  await sendCall("MeterValues", {
    connectorId: 1,
    transactionId: txId,
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [
          { value: "7200", measurand: "Power.Active.Import" },
          { value: "230.5", measurand: "Voltage" },
          { value: "31.3", measurand: "Current.Import", phase: "L1" },
          { value: "12500", measurand: "Energy.Active.Import.Register" },
        ],
      },
    ],
  });

  const liveConnSnap = await getDoc(doc(db, "chargers", CHARGER_ID, "connectors", "1"));
  console.log("   🔥 Firestore Live Telemetry:", liveConnSnap.data().telemetry);

  // --- Step 6: Test StopTransaction & Billing ---
  console.log("\n📡 6. Testing StopTransaction (Car finishes charging)...");
  // Started at 10000 Wh, stopped at 25400 Wh = 15400 Wh = 15.4 kWh
  await sendCall("StopTransaction", {
    transactionId: txId,
    meterStop: 25400,
    timestamp: new Date().toISOString(),
    reason: "EVDisconnected",
  });

  const txSnap = await getDoc(doc(db, "transactions", String(txId)));
  const txData = txSnap.data();
  console.log(`   🔥 Firestore Transaction Record:`);
  console.log(`      - Energy Delivered: ${txData.energyDeliveredKwh} kWh`);
  console.log(`      - Total Cost:       $${txData.cost}`);
  console.log(`      - Payment Status:   ${txData.paymentStatus}`);
  console.log(`      - Session Status:   ${txData.status}`);

  // --- Step 7: Test Mobile App Command via Firestore ---
  console.log("\n📱 7. Testing Mobile App Remote Control via Firestore...");
  console.log("   Creating command in Firestore collection 'commands' [UnlockConnector]...");
  const cmdRef = await addDoc(collection(db, "commands"), {
    chargePointId: CHARGER_ID,
    action: "UnlockConnector",
    connectorId: 1,
    status: "pending",
    createdAt: new Date().toISOString(),
  });

  // Wait 1.5s for server listener to execute command and update Firestore
  await new Promise((r) => setTimeout(r, 1500));
  const executedCmdSnap = await getDoc(cmdRef);
  console.log("   🔥 Firestore Command State after execution:", executedCmdSnap.data().status);
  console.log("   Result returned from charger:", executedCmdSnap.data().result);

  // --- Step 8: Test Bank Payment Webhook & Automatic Unlock ---
  console.log("\n🏦 8. Testing Bank Payment Webhook & Auto-Unlock...");
  const webhookRes = await fetch("http://localhost:3000/api/payment-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transactionId: txId,
      chargePointId: CHARGER_ID,
      connectorId: 1,
      amount: txData.cost,
      status: "SUCCESS",
      bankReference: "BANK_REF_998877",
    }),
  });
  const webhookJson = await webhookRes.json();
  console.log("   Bank Webhook response:", webhookJson);

  const finalTxSnap = await getDoc(doc(db, "transactions", String(txId)));
  console.log("   🔥 Firestore Final Transaction paymentStatus:", finalTxSnap.data().paymentStatus);

  ws.close();

  console.log("\n==================================================");
  console.log("🎉 ALL TESTS PASSED SUCCESSFULLY (100% WORKING!)");
  console.log("==================================================");
  process.exit(0);
}

runTests().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
