import { initDatabase, db } from "./server/src/database/db.js";
import express from "./server/node_modules/express/index.js";
import http from "http";
import { apiRouter } from "./server/src/routes/api.js";
import { ocppServer } from "./server/src/ocpp/OCPPServer.js";

const PORT = 4015;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

async function run() {
  console.log("====================================================");
  console.log("🔒 MULTI-TENANT USER & CHARGER ISOLATION TEST SUITE");
  console.log("====================================================\n");

  initDatabase();

  const app = express();
  app.use(express.json());
  app.use("/api", apiRouter);
  const server = http.createServer(app);
  ocppServer.attach(server);

  await new Promise((res) => server.listen(PORT, "127.0.0.1", res));

  try {
    // 1. Register User A (bound to charger1)
    const emailA = `telsa_${Date.now()}@teksa.cok`;
    const regResA = await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: emailA, password: "password123", displayName: "Telsa", stationId: "charger1" }),
    });
    const dataA = await regResA.json();
    assert(dataA.success && dataA.user.stationId === "charger1", "User A registered and bound to charger1");
    const tokenA = dataA.token;

    // 2. Register User B (bound to aziz light and solar)
    const emailB = `hafeez_${Date.now()}@gmail.com`;
    const regResB = await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: emailB, password: "password123", displayName: "Hafeez", stationId: "aziz light and solar" }),
    });
    const dataB = await regResB.json();
    assert(dataB.success && dataB.user.stationId === "aziz light and solar", "User B registered and bound to aziz light and solar");
    const tokenB = dataB.token;

    // 3. User B attempts to change tariff on User A's charger1 -> MUST BE 403 FORBIDDEN
    const crossTariffRes = await fetch(`${BASE_URL}/api/chargers/charger1/tariff`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ tariffRate: 90 }),
    });
    assert(crossTariffRes.status === 403, "User B blocked (403) from changing tariff on charger1");

    // 4. User B updates tariff on their own charger (aziz light and solar) -> MUST SUCCEED
    const ownTariffRes = await fetch(`${BASE_URL}/api/chargers/aziz%20light%20and%20solar/tariff`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ tariffRate: 90 }),
    });
    const ownTariffData = await ownTariffRes.json();
    assert(ownTariffRes.status === 200 && ownTariffData.tariffRate === 90, "User B successfully updated tariff on their own charger");

    // 5. User A updates tariff on their own charger (charger1) -> MUST SUCCEED
    const aTariffRes = await fetch(`${BASE_URL}/api/chargers/charger1/tariff`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ tariffRate: 125 }),
    });
    const aTariffData = await aTariffRes.json();
    assert(aTariffRes.status === 200 && aTariffData.tariffRate === 125, "User A successfully confirmed tariff 125 on charger1");

    // 6. User A attempts command on User B's charger -> MUST BE 403 FORBIDDEN
    const crossCommandRes = await fetch(`${BASE_URL}/api/commands/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ chargePointId: "aziz light and solar", action: "UnlockConnector", connectorId: 1 }),
    });
    assert(crossCommandRes.status === 403, "User A blocked (403) from controlling User B's charger");

    // 7. User B attempts remote stop on User A's charger -> MUST BE 403 FORBIDDEN
    const crossStopRes = await fetch(`${BASE_URL}/api/chargers/charger1/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ connectorId: 1 }),
    });
    assert(crossStopRes.status === 403, "User B blocked (403) from stopping charger1");

    // 8. Chargers list isolation: User B only sees their charger
    const listResB = await fetch(`${BASE_URL}/api/chargers`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const listDataB = await listResB.json();
    const bHasOnlyOwn = listDataB.chargers.every((c) => c.chargePointId === "aziz light and solar");
    assert(bHasOnlyOwn && listDataB.chargers.length === 1, "User B only sees aziz light and solar in /api/chargers");

    // 9. Chargers list isolation: User A only sees their charger
    const listResA = await fetch(`${BASE_URL}/api/chargers`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const listDataA = await listResA.json();
    const aHasOnlyOwn = listDataA.chargers.every((c) => c.chargePointId === "charger1");
    assert(aHasOnlyOwn && listDataA.chargers.length === 1, "User A only sees charger1 in /api/chargers");

    // 10. Register User C without providing stationId (e.g. fresh signup)
    const emailC = `newuser_${Date.now()}@example.com`;
    const regResC = await fetch(`${BASE_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: emailC, password: "password123", displayName: "NewUser" }),
    });
    const dataC = await regResC.json();
    assert(dataC.success && (!dataC.user.stationId || dataC.user.stationId === ""), "New User C registered with NO station assigned (NOT charger1)");
    const tokenC = dataC.token;

    // 11. User C attempts cross-access on charger1 -> MUST BE 403 FORBIDDEN
    const crossTariffC = await fetch(`${BASE_URL}/api/chargers/charger1/tariff`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenC}` },
      body: JSON.stringify({ tariffRate: 50 }),
    });
    assert(crossTariffC.status === 403, "Unconfigured User C blocked (403) from modifying charger1 tariff");

    // 12. User C completes setup with their own station "charger3"
    const setupResC = await fetch(`${BASE_URL}/api/auth/station`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenC}` },
      body: JSON.stringify({ stationId: "charger3" }),
    });
    const setupDataC = await setupResC.json();
    assert(setupResC.status === 200 && setupDataC.stationId === "charger3", "User C successfully saved their own station ID");

    // 13. Verify /auth/me for User C now reflects charger3
    const meResC = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${tokenC}` },
    });
    const meDataC = await meResC.json();
    assert(meDataC.user.stationId === "charger3", "User C /auth/me confirms bound station is charger3 (never charger1)");

    console.log("\n====================================================");
    console.log(`📊 TENANT ISOLATION SUMMARY: Passed: ${passed}, Failed: ${failed}`);
    console.log("====================================================");
  } finally {
    server.close();
  }
}

run().catch((e) => {
  console.error("FATAL TEST ERROR:", e);
  process.exit(1);
});
