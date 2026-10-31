import WebSocket from './server/node_modules/ws/index.js';

const PORT = 4010;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/api/ocpp/version/1.6/charger1`;

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    testsPassed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    testsFailed++;
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runComprehensiveTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING COMPREHENSIVE END-TO-END TEST SUITE');
  console.log('====================================================\n');

  // ==========================================
  // SECTION 1: AUTHENTICATION & SECURITY
  // ==========================================
  console.log('[SECTION 1] Testing Authentication & Security...');

  // 1.1 Register
  const testEmail = `admin_${Date.now()}@tesla-charge.online`;
  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail, password: 'securePassword123', displayName: 'Station Admin' }),
  });
  const regData = await regRes.json();
  assert(regData.success === true && regData.token, 'Register creates user & returns JWT');
  const token = regData.token;

  // 1.2 Duplicate Register
  const dupRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail, password: 'anotherPassword' }),
  });
  const dupData = await dupRes.json();
  assert(dupRes.status === 409 && dupData.success === false, 'Duplicate registration correctly rejected (409)');

  // 1.3 Login Wrong Password
  const wrongLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail, password: 'wrongPassword' }),
  });
  assert(wrongLoginRes.status === 401, 'Login with wrong password rejected (401)');

  // 1.4 Login Valid Password
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail, password: 'securePassword123' }),
  });
  const loginData = await loginRes.json();
  assert(loginData.success === true && loginData.user?.email === testEmail, 'Login succeeds and returns user profile');

  // 1.5 Authenticated Route (/api/auth/me)
  const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meData = await meRes.json();
  assert(meData.success === true && meData.user?.email === testEmail, '/api/auth/me returns valid user session');

  // 1.6 Invalid Token Rejected
  const invalidMeRes = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { Authorization: 'Bearer invalid.token.value' },
  });
  assert(invalidMeRes.status === 401 || invalidMeRes.status === 403, 'Invalid JWT token correctly rejected (401/403)');

  // ==========================================
  // SECTION 2: CHARGER CONFIGURATION & TARIFFS
  // ==========================================
  console.log('\n[SECTION 2] Testing Charger Config & Tariffs...');

  // 2.1 Get Initial Status
  const statusRes = await fetch(`${BASE_URL}/api/status`);
  const statusData = await statusRes.json();
  assert(statusData.success === true && statusData.targetChargerId === 'charger1', 'Status endpoint returns charger1 data');
  assert(Array.isArray(statusData.connectors) && statusData.connectors.length >= 2, 'Default connectors initialized');

  // 2.2 Get Chargers List
  const chargersRes = await fetch(`${BASE_URL}/api/chargers`);
  const chargersData = await chargersRes.json();
  assert(chargersData.success === true && chargersData.chargers.length > 0, 'Chargers list returns stations');

  // 2.3 Update Station Tariff (e.g. from default 125 to 150 PKR/kWh)
  const patchTariffRes = await fetch(`${BASE_URL}/api/chargers/charger1/tariff`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tariffRate: 150.0 }),
  });
  const patchData = await patchTariffRes.json();
  assert(patchData.success === true && patchData.tariffRate === 150.0, 'Tariff rate updated to 150 PKR/kWh');

  // Verify persistence in SQLite
  const verifyChargerRes = await fetch(`${BASE_URL}/api/chargers/charger1`);
  const verifyCharger = await verifyChargerRes.json();
  assert(verifyCharger.charger?.tariffRate === 150.0 || verifyCharger.charger?.tariff_rate === 150.0, 'Tariff persistence confirmed in SQLite');

  // ==========================================
  // SECTION 3: PHYSICAL OCPP 1.6-J HARDWARE SIMULATION
  // ==========================================
  console.log('\n[SECTION 3] Testing OCPP 1.6-J Hardware Protocol...');

  // 3.1 Establish WebSocket connection
  const ws = new WebSocket(WS_URL, ['ocpp1.6']);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  assert(ws.readyState === WebSocket.OPEN, 'Charger connected via WebSocket (ocpp1.6 subprotocol)');

  let msgIdCounter = 100;
  function ocppCall(action, payload) {
    const id = String(msgIdCounter++);
    return new Promise((resolve) => {
      const onMsg = (raw) => {
        try {
          const [type, recvId, result] = JSON.parse(raw);
          if (type === 3 && recvId === id) {
            ws.removeListener('message', onMsg);
            resolve(result);
          }
        } catch (_e) {}
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify([2, id, action, payload]));
    });
  }

  // 3.2 BootNotification
  const bootResp = await ocppCall('BootNotification', {
    chargePointVendor: 'DC_TYPE',
    chargePointModel: '240kW',
    chargePointSerialNumber: 'TC-240KW-001',
    firmwareVersion: 'v2.4.1',
  });
  assert(bootResp.status === 'Accepted', 'BootNotification accepted by server');

  // 3.3 Heartbeat
  const hbResp = await ocppCall('Heartbeat', {});
  assert(Boolean(hbResp.currentTime), 'Heartbeat accepted with synchronized currentTime');

  // 3.4 StatusNotification: Gun 1 -> Preparing
  await ocppCall('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Preparing' });
  const liveAfterPrep = await (await fetch(`${BASE_URL}/api/status`)).json();
  const conn1Prep = liveAfterPrep.connectors.find((c) => c.connectorId === 1);
  assert(conn1Prep?.status === 'Preparing', 'Gun 1 transitioned to Preparing in database');

  // 3.5 RFID Tag Authorization
  const authResp = await ocppCall('Authorize', { idTag: 'TAG-AUTONOMOUS-TEST' });
  assert(authResp.idTagInfo?.status === 'Accepted', 'RFID Tag authorized by server');

  // 3.6 StartTransaction
  const startTxResp = await ocppCall('StartTransaction', {
    connectorId: 1,
    idTag: 'TAG-AUTONOMOUS-TEST',
    meterStart: 10000, // 10 kWh initial meter
    timestamp: new Date().toISOString(),
  });
  const txId = startTxResp.transactionId;
  assert(typeof txId === 'number' && txId > 0, `StartTransaction created active session #${txId}`);

  // 3.7 StatusNotification: Gun 1 -> Charging
  await ocppCall('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Charging' });

  // 3.8 MeterValues (streaming active telemetry: 60kW, 400V, 150A, 25kWh delivered, 60% SoC)
  await ocppCall('MeterValues', {
    connectorId: 1,
    transactionId: txId,
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [
          { value: '35000', measurand: 'Energy.Active.Import.Register', unit: 'Wh' }, // 35 - 10 = 25 kWh delivered
          { value: '60000', measurand: 'Power.Active.Import', unit: 'W' },
          { value: '400', measurand: 'Voltage', unit: 'V' },
          { value: '150', measurand: 'Current.Import', unit: 'A' },
          { value: '60', measurand: 'SoC', unit: 'Percent' },
        ],
      },
    ],
  });

  // Verify live telemetry updated in server
  const liveAfterMeter = await (await fetch(`${BASE_URL}/api/status`)).json();
  const conn1Charging = liveAfterMeter.connectors.find((c) => c.connectorId === 1);
  assert(conn1Charging?.status === 'Charging', 'Gun 1 confirmed actively Charging');
  assert(conn1Charging?.telemetry?.powerKw === 60, 'Live power telemetry: 60 kW');
  assert(conn1Charging?.telemetry?.soc === 60, 'Live battery SoC: 60%');
  assert(conn1Charging?.telemetry?.cost === 25 * 150, 'Live cost accurately calculated (25 kWh * 150 = PKR 3,750)');

  // ==========================================
  // SECTION 4: DIRECT REMOTE APP COMMAND DISPATCH
  // ==========================================
  console.log('\n[SECTION 4] Testing Direct Remote Command Dispatch...');

  // Setup handler on simulated charger to respond to incoming OCPP Calls from the server
  ws.on('message', (raw) => {
    try {
      const [type, msgId, action] = JSON.parse(raw);
      if (type === 2) {
        if (action === 'RemoteStopTransaction') {
          ws.send(JSON.stringify([3, msgId, { status: 'Accepted' }]));
        } else if (action === 'UnlockConnector') {
          ws.send(JSON.stringify([3, msgId, { status: 'Unlocked' }]));
        } else if (action === 'Reset') {
          ws.send(JSON.stringify([3, msgId, { status: 'Accepted' }]));
        } else if (action === 'TriggerMessage') {
          ws.send(JSON.stringify([3, msgId, { status: 'Accepted' }]));
        }
      }
    } catch (_e) {}
  });

  // 4.1 Remote Stop Command from App via REST
  const remoteStopRes = await fetch(`${BASE_URL}/api/commands/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      chargePointId: 'charger1',
      command: 'RemoteStopTransaction',
      parameters: { transactionId: txId },
    }),
  });
  const remoteStopData = await remoteStopRes.json();
  assert(remoteStopData.success === true && (remoteStopData.result?.status === 'Accepted' || remoteStopData.response?.status === 'Accepted'), 'RemoteStopTransaction dispatched directly to charger and accepted');

  // 4.2 Charger completes StopTransaction
  const stopTxResp = await ocppCall('StopTransaction', {
    transactionId: txId,
    meterStop: 40000, // 40 - 10 = 30 kWh total
    timestamp: new Date().toISOString(),
    reason: 'Remote',
  });
  assert(stopTxResp.idTagInfo?.status === 'Accepted', 'StopTransaction saved and acknowledged');

  // 4.3 Remote Unlock Connector from App
  const unlockRes = await fetch(`${BASE_URL}/api/chargers/charger1/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ connectorId: 1 }),
  });
  const unlockData = await unlockRes.json();
  assert(unlockData.success === true && (unlockData.result?.status === 'Unlocked' || unlockData.response?.status === 'Unlocked'), 'Remote UnlockConnector executed and returned Unlocked');

  // 4.4 Disconnect Charger (simulates network drop)
  ws.close();
  await sleep(200);

  const liveAfterDisconnect = await (await fetch(`${BASE_URL}/api/status`)).json();
  assert(liveAfterDisconnect.charger?.status === 'Offline', 'Charger state immediately transitions to Offline upon socket disconnect');

  // 4.5 Dispatch to Offline Charger returns proper error
  const offlineCmdRes = await fetch(`${BASE_URL}/api/commands/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ chargePointId: 'charger1', command: 'Reset', parameters: { type: 'Soft' } }),
  });
  const offlineCmdData = await offlineCmdRes.json();
  assert(offlineCmdRes.status === 404 || offlineCmdData.success === false, 'Command to offline charger gracefully rejected');

  // ==========================================
  // SECTION 5: TRANSACTIONS & BILLING AUDIT
  // ==========================================
  console.log('\n[SECTION 5] Testing Transactions & Billing Audit...');

  const txHistoryRes = await fetch(`${BASE_URL}/api/transactions?chargePointId=charger1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const txHistory = await txHistoryRes.json();
  assert(txHistory.success === true && txHistory.transactions.length > 0, 'Transactions history fetched successfully');

  const session = txHistory.transactions.find((t) => t.transactionId === txId);
  assert(Boolean(session), `Completed session #${txId} found in transaction history`);
  assert(session?.energyDeliveredKwh === 30, 'Final energy registered: 30 kWh');
  assert(session?.cost === 30 * 150, 'Final bill matches tariff: PKR 4,500');
  assert(session?.status === 'Completed', 'Session status marked Completed');
  assert(session?.stopReason === 'Remote' || session?.reason === 'Remote', 'Stop reason recorded as Remote');

  // ==========================================
  // SECTION 6: RFID & NFC WHITELIST MANAGEMENT
  // ==========================================
  console.log('\n[SECTION 6] Testing RFID Whitelist Management...');

  const tagId = 'TEST-RFID-PASS-42';
  // Add Tag
  const addTagRes = await fetch(`${BASE_URL}/api/chargers/charger1/rfid-tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tagId, userEmail: 'operator@tcharge.pk' }),
  });
  assert((await addTagRes.json()).success === true, 'RFID tag added to whitelist');

  // List Tags
  const listTagsRes = await fetch(`${BASE_URL}/api/chargers/charger1/rfid-tags`);
  const tagsList = await listTagsRes.json();
  const foundTag = tagsList.tags?.find((t) => t.tag_id === tagId);
  assert(Boolean(foundTag), 'RFID tag confirmed in database query');

  // Delete Tag
  const delTagRes = await fetch(`${BASE_URL}/api/chargers/charger1/rfid-tags/${tagId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert((await delTagRes.json()).success === true, 'RFID tag deleted from whitelist');

  // Confirm Deletion
  const listAfterDel = await (await fetch(`${BASE_URL}/api/chargers/charger1/rfid-tags`)).json();
  assert(!listAfterDel.tags?.some((t) => t.tag_id === tagId), 'RFID tag no longer present in database');

  // ==========================================
  // FINAL RESULTS SUMMARY
  // ==========================================
  console.log('\n====================================================');
  console.log(`📊 FINAL TEST SUMMARY:`);
  console.log(`   Passed: ${testsPassed}`);
  console.log(`   Failed: ${testsFailed}`);
  console.log('====================================================');

  if (testsFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runComprehensiveTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
