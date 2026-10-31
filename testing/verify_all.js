import WebSocket from './server/node_modules/ws/index.js';

const BASE_URL = 'http://127.0.0.1:4005';
const WS_URL = 'ws://127.0.0.1:4005/api/ocpp/version/1.6/test-charger';

async function runTest() {
  console.log('--- STARTING VERIFICATION TEST ON TESTING SERVER ---');

  // 1. Register User
  console.log('\n[1] Testing Auth: Register');
  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'tester@tesla-charge.online',
      password: 'password123',
      displayName: 'Test Operator',
    }),
  });
  const regData = await regRes.json();
  console.log('Register response:', regData);

  // 2. Login User
  console.log('\n[2] Testing Auth: Login');
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'tester@tesla-charge.online',
      password: 'password123',
    }),
  });
  const loginData = await loginRes.json();
  console.log('Login success:', loginData.success, 'Token prefix:', loginData.token?.substring(0, 15));
  const token = loginData.token;

  // 3. Test /api/status
  console.log('\n[3] Testing /api/status');
  const statusRes = await fetch(`${BASE_URL}/api/status`);
  const statusData = await statusRes.json();
  console.log('Status success:', statusData.success, 'Charger:', statusData.charger?.chargePointId, 'Connectors:', statusData.connectors?.length);

  // 4. Test Simulated OCPP 1.6 Client over WebSocket
  console.log('\n[4] Connecting Simulated OCPP Charger to', WS_URL);
  const ws = new WebSocket(WS_URL, ['ocpp1.6']);

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('WebSocket connected successfully');
      resolve();
    });
    ws.on('error', reject);
  });

  let msgId = 1;
  function sendCall(action, payload) {
    const id = String(msgId++);
    const frame = [2, id, action, payload];
    return new Promise((resolve) => {
      const handler = (raw) => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed[0] === 3 && parsed[1] === id) {
            ws.removeListener('message', handler);
            resolve(parsed[2]);
          }
        } catch (_e) {}
      };
      ws.on('message', handler);
      ws.send(JSON.stringify(frame));
    });
  }

  // 4a. BootNotification
  console.log('Sending BootNotification...');
  const bootRes = await sendCall('BootNotification', {
    chargePointVendor: 'DC_TYPE',
    chargePointModel: '240kW',
    firmwareVersion: '1.2.0',
  });
  console.log('BootNotification Response:', bootRes);

  // 4b. StatusNotification
  console.log('Sending StatusNotification (Preparing)...');
  const statusNotifRes = await sendCall('StatusNotification', {
    connectorId: 1,
    errorCode: 'NoError',
    status: 'Preparing',
  });
  console.log('StatusNotification Response:', statusNotifRes);

  // 4c. StartTransaction
  console.log('Sending StartTransaction...');
  const startTxRes = await sendCall('StartTransaction', {
    connectorId: 1,
    idTag: 'TEST-RFID-1234',
    meterStart: 10000,
    timestamp: new Date().toISOString(),
  });
  console.log('StartTransaction Response:', startTxRes);
  const txId = startTxRes.transactionId;

  // 4d. MeterValues
  console.log('Sending MeterValues...');
  const meterRes = await sendCall('MeterValues', {
    connectorId: 1,
    transactionId: txId,
    meterValue: [
      {
        timestamp: new Date().toISOString(),
        sampledValue: [
          { value: '15000', context: 'Sample.Periodic', format: 'Raw', measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
          { value: '60000', context: 'Sample.Periodic', format: 'Raw', measurand: 'Power.Active.Import', unit: 'W' },
          { value: '380', context: 'Sample.Periodic', format: 'Raw', measurand: 'Voltage', unit: 'V' },
          { value: '65', context: 'Sample.Periodic', format: 'Raw', measurand: 'SoC', unit: 'Percent' },
        ],
      },
    ],
  });
  console.log('MeterValues Response:', meterRes);

  // 4e. StopTransaction
  console.log('Sending StopTransaction...');
  const stopTxRes = await sendCall('StopTransaction', {
    transactionId: txId,
    meterStop: 25000,
    timestamp: new Date().toISOString(),
    reason: 'Remote',
  });
  console.log('StopTransaction Response:', stopTxRes);

  ws.close();

  // 5. Query Transactions via REST API
  console.log('\n[5] Querying /api/transactions with JWT');
  const txRes = await fetch(`${BASE_URL}/api/transactions?chargePointId=test-charger`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const txData = await txRes.json();
  console.log('Transactions fetched:', txData.transactions?.length);
  if (txData.transactions?.length > 0) {
    const recorded = txData.transactions[0];
    console.log('Recorded Tx:', {
      transactionId: recorded.transaction_id,
      energyKwh: recorded.energy_kwh,
      cost: recorded.cost,
      status: recorded.status,
    });
  }

  // 6. Test RFID API
  console.log('\n[6] Testing RFID Tag APIs');
  const addTagRes = await fetch(`${BASE_URL}/api/chargers/test-charger/rfid-tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tagId: 'MY-TEST-TAG', userEmail: 'driver@test.com' }),
  });
  console.log('Add RFID Tag Response:', await addTagRes.json());

  const getTagsRes = await fetch(`${BASE_URL}/api/chargers/test-charger/rfid-tags`);
  const tagsList = await getTagsRes.json();
  console.log('RFID Tags List count:', tagsList.tags?.length);

  const delTagRes = await fetch(`${BASE_URL}/api/chargers/test-charger/rfid-tags/MY-TEST-TAG`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log('Delete RFID Tag Response:', await delTagRes.json());

  console.log('\n=== ALL VERIFICATION TESTS COMPLETED SUCCESSFULLY ===');
  process.exit(0);
}

runTest().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
