import { db, rtdb } from "../config/firebase.js";
import { doc, setDoc, getDoc, updateDoc, collection, query, where, limit, getDocs, deleteField } from "firebase/firestore";
import { ref, update, set, get, remove } from "firebase/database";
import fs from "fs";
import path from "path";
import { sendPushNotification } from "./notificationService.js";

/**
 * Fetch push tokens registered for a charger
 */
async function getSubscribedPushTokens(chargePointId) {
  try {
    const snap = await get(ref(rtdb, `notifications/subscribers/${chargePointId}`));
    if (snap.exists()) {
      const data = snap.val();
      return Object.values(data).map((v) => v.token).filter(Boolean);
    }
  } catch (err) {
    console.warn("[Push] Error fetching push tokens:", err.message);
  }
  return [];
}

const LOCAL_DATA_FILE = path.join(process.cwd(), "data", "transactions.json");

export function saveLocalServerTransaction(tx) {
  try {
    const dir = path.dirname(LOCAL_DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let existing = [];
    if (fs.existsSync(LOCAL_DATA_FILE)) {
      try {
        existing = JSON.parse(fs.readFileSync(LOCAL_DATA_FILE, "utf8"));
      } catch (_e) {
        existing = [];
      }
    }
    const txId = String(tx.transactionId || tx.id);
    const idx = existing.findIndex((t) => String(t.transactionId || t.id) === txId);
    if (idx >= 0) {
      existing[idx] = { ...existing[idx], ...tx };
    } else {
      existing.unshift(tx);
    }
    fs.writeFileSync(LOCAL_DATA_FILE, JSON.stringify(existing, null, 2), "utf8");
    console.log(`[LocalStorage] Saved session #${txId} to data/transactions.json`);
  } catch (err) {
    console.error("[LocalStorage Error] saveLocalServerTransaction:", err.message);
  }
}

export function getLocalServerTransactions() {
  try {
    if (fs.existsSync(LOCAL_DATA_FILE)) {
      return JSON.parse(fs.readFileSync(LOCAL_DATA_FILE, "utf8"));
    }
  } catch (_e) {}
  return [];
}

/**
 * HYBRID STORAGE LAYOUT
 * ─────────────────────────────────────────────────────────────────────────
 * Realtime Database (cheap, high-frequency, billed by bandwidth):
 *   live/{chargerId}/status              "Online" | "Offline"
 *   live/{chargerId}/lastHeartbeat       ISO string
 *   live/{chargerId}/connectors/{id}     { status, errorCode, info, updatedAt, telemetry{...} }
 *   live/{chargerId}/activeTx/{connId}   { transactionId, idTag, startTime, meterStart, currentPowerKw, currentEnergyWh, socStart, socCurrent }
 *   live/{chargerId}/lastCompletedTx     full summary of the most recently finished session (with socStart, socStop)
 *
 * Firestore (permanent, queryable, billed per document op):
 *   chargers/{chargerId}                 hardware info + setup (model, location)
 *   transactions/{transactionId}         written ONLY on start and stop (with socStart, socStop, cost, energy)
 *
 * Local Server Disk (data/transactions.json):
 *   full json backup of all sessions with start/stop percentages and costs
 * ─────────────────────────────────────────────────────────────────────────
 */

const nowIso = () => new Date().toISOString();

// RTDB keys cannot contain . # $ [ ] /
const safeKey = (id) => String(id).replace(/[.#$[\]/]/g, "_");
const livePath = (chargePointId, ...parts) =>
  ["live", safeKey(chargePointId), ...parts.map(safeKey)].join("/");

/**
 * Sync charger registration and boot notification
 * Firestore: hardware info (rare). RTDB: online status.
 */
export async function saveChargerBoot(chargePointId, data) {
  try {
    // Preserve existing user-configured display model
    let existingModel = null;
    try {
      const existingSnap = await getDoc(doc(db, "chargers", chargePointId));
      if (existingSnap.exists()) {
        const exData = existingSnap.data() || {};
        const m = exData.model || exData.displayModel;
        if (m && m !== "Unknown" && m !== "DC_EVSE") {
          existingModel = m;
        }
      }
    } catch (_lookupErr) {}

    const bootDoc = {
      chargePointId,
      vendor: data.chargePointVendor || "Unknown",
      hardwareModel: data.chargePointModel || "Unknown",
      firmwareVersion: data.firmwareVersion || "Unknown",
      meterType: data.meterType || "Unknown",
      lastBootAt: nowIso(),
      updatedAt: nowIso(),
    };

    if (existingModel) {
      bootDoc.model = existingModel;
      bootDoc.displayModel = existingModel;
    } else {
      bootDoc.model = "240kW";
      bootDoc.displayModel = "240kW";
    }

    await setDoc(doc(db, "chargers", chargePointId), bootDoc, { merge: true });

    await update(ref(rtdb, livePath(chargePointId)), {
      chargePointId,
      status: "Online",
      lastHeartbeat: nowIso(),
      updatedAt: nowIso(),
    });
    console.log(`[Hybrid] Boot info saved (Firestore) + Online (RTDB): ${chargePointId} [Model: ${bootDoc.model}]`);
  } catch (err) {
    console.error(`[Hybrid Error] saveChargerBoot for ${chargePointId}:`, err.message);
  }
}

/**
 * Heartbeat -> RTDB only (was a Firestore write every 30s)
 */
export async function saveChargerHeartbeat(chargePointId) {
  try {
    await update(ref(rtdb, livePath(chargePointId)), {
      chargePointId,
      status: "Online",
      lastHeartbeat: nowIso(),
    });
  } catch (err) {
    console.error(`[RTDB Error] saveChargerHeartbeat for ${chargePointId}:`, err.message);
  }
}

/**
 * Mark charger offline when its WebSocket closes -> RTDB only
 */
export async function saveChargerOffline(chargePointId) {
  try {
    await update(ref(rtdb, livePath(chargePointId)), {
      status: "Offline",
      updatedAt: nowIso(),
    });
    console.log(`[RTDB] Charger ${chargePointId} marked Offline`);
  } catch (err) {
    console.error(`[RTDB Error] saveChargerOffline for ${chargePointId}:`, err.message);
  }
}

/**
 * Connector status change (Available, Preparing, Charging, Faulted...) -> RTDB & Firestore
 */
export async function saveConnectorStatus(chargePointId, connectorId, status, errorCode, info) {
  try {
    const connIdNum = Number(connectorId);
    const updates = {};
    updates[livePath(chargePointId, "connectors", connIdNum, "status")] = status;
    updates[livePath(chargePointId, "connectors", connIdNum, "errorCode")] = errorCode || "NoError";
    updates[livePath(chargePointId, "connectors", connIdNum, "info")] = info || "";
    updates[livePath(chargePointId, "connectors", connIdNum, "updatedAt")] = nowIso();

    // If status is not Charging, clear any activeTx from RTDB
    if (status === "Available" || status === "Unavailable" || status === "Faulted") {
      updates[livePath(chargePointId, "connectors", connIdNum, "activeTx")] = null;
      updates[livePath(chargePointId, "activeTx", connIdNum)] = null;
    }

    await update(ref(rtdb), updates);

    // Sync status to Firestore connector doc and summary
    const fsDoc = {
      status,
      errorCode: errorCode || "NoError",
      info: info || "",
      updatedAt: nowIso(),
    };
    if (status === "Available" || status === "Unavailable" || status === "Faulted") {
      fsDoc.activeTx = deleteField();
    }

    await setDoc(
      doc(db, "chargers", chargePointId, "connectors", String(connIdNum)),
      fsDoc,
      { merge: true }
    ).catch(() => {});

    await setDoc(
      doc(db, "chargers", chargePointId),
      {
        [`connector_${connIdNum}_status`]: status,
        updatedAt: nowIso(),
      },
      { merge: true }
    ).catch(() => {});

    // Push Notification: When a car is plugged in (status transition to Preparing)
    if (status === "Preparing") {
      getSubscribedPushTokens(chargePointId).then((tokens) => {
        const gunName = connIdNum === 2 ? "Gun B" : "Gun A";
        sendPushNotification(tokens, {
          title: "🔌 Vehicle Connected",
          body: `A vehicle was plugged into ${gunName} at ${chargePointId.toUpperCase()}.`,
          data: { chargePointId, connectorId: connIdNum, status: "Preparing" },
        });
      });
    }

    console.log(`[Status] Charger ${chargePointId} Connector ${connectorId} status: ${status}`);
  } catch (err) {
    console.error(`[Status Error] saveConnectorStatus:`, err.message);
  }
}

/**
 * Real-time telemetry (kW, V, A, Wh, SoC) -> RTDB only
 * This was the most expensive Firestore path (1-2 writes every 10-15s per connector).
 */
export async function saveMeterValues(chargePointId, connectorId, transactionId, telemetryData) {
  try {
    // Drop the raw OCPP payload: it is large and not needed by any client (saves bandwidth)
    const { raw: _raw, ...telemetry } = telemetryData || {};
    const targetConnId = Number(connectorId || 1);

    const updates = {};
    updates[livePath(chargePointId, "connectors", targetConnId, "telemetry")] = {
      ...telemetry,
      updatedAt: nowIso(),
    };

    // 1. Resolve transactionId if present or actively running
    let resolvedTxId = transactionId ? Number(transactionId) : null;
    let act = {};
    const txBase = livePath(chargePointId, "activeTx", targetConnId);

    if (resolvedTxId) {
      try {
        const activeSnap = await get(ref(rtdb, txBase));
        if (activeSnap.exists()) {
          act = activeSnap.val() || {};
        }
      } catch (_e) {}
    } else {
      // If transactionId was omitted by charger, ONLY consider it active if RTDB currently has a Charging session
      try {
        const activeSnap = await get(ref(rtdb, txBase));
        if (activeSnap.exists()) {
          const val = activeSnap.val() || {};
          if (val.transactionId && val.status === "Charging") {
            act = val;
            resolvedTxId = Number(val.transactionId);
          }
        }
      } catch (_e) {}

      // Fallback: check Firestore transactions ONLY for currently active status == 'Charging'
      if (!resolvedTxId) {
        try {
          const qActive = query(
            collection(db, "transactions"),
            where("chargePointId", "==", chargePointId),
            where("connectorId", "==", targetConnId),
            where("status", "==", "Charging"),
            limit(1)
          );
          const qSnap = await getDocs(qActive);
          if (!qSnap.empty) {
            const tDoc = qSnap.docs[0].data();
            act = { ...tDoc, ...act };
            resolvedTxId = Number(tDoc.transactionId || qSnap.docs[0].id);
          }
        } catch (_qErr) {}
      }
    }

    // If NO active charging session is found, this is a periodic idle/clock-aligned meter value
    if (!resolvedTxId) {
      // Dual-write telemetry only — do NOT set status to Charging, do NOT create activeTx
      try {
        const connDocRef = doc(db, "chargers", chargePointId, "connectors", String(targetConnId));
        await setDoc(
          connDocRef,
          {
            telemetry: {
              ...telemetry,
              updatedAt: nowIso(),
            },
            updatedAt: nowIso(),
          },
          { merge: true }
        );
      } catch (_fsErr) {}

      await update(ref(rtdb), updates);
      return;
    }

    // Active charging session exists: compute energy and live cost
    let sessionEnergyWh = 0;
    let sessionEnergyKwh = 0;
    let effectiveTariff = act.tariffRate && Number(act.tariffRate) > 0 ? Number(act.tariffRate) : 125;

    const mStart = typeof act.meterStart === 'number' ? act.meterStart : (Number(act.meterStart) || 0);

    // If meterStart is recorded and current telemetry has register value, compute session delta
    if (telemetry.energyWh > 0 && mStart > 0 && telemetry.energyWh >= mStart) {
      sessionEnergyWh = telemetry.energyWh - mStart;
      sessionEnergyKwh = Number((sessionEnergyWh / 1000).toFixed(2));
    } else if (telemetry.energyKwh > 0 && mStart > 0 && (telemetry.energyKwh * 1000) >= mStart) {
      sessionEnergyWh = Math.round(telemetry.energyKwh * 1000) - mStart;
      sessionEnergyKwh = Number((sessionEnergyWh / 1000).toFixed(2));
    } else if (act.energyDeliveredKwh > 0) {
      sessionEnergyKwh = Number(act.energyDeliveredKwh);
      sessionEnergyWh = act.energyDeliveredWh || Math.round(sessionEnergyKwh * 1000);
    }

    const liveCost = Number((sessionEnergyKwh * effectiveTariff).toFixed(2));
    const isActivelyPowering = (telemetry.powerKw || 0) > 0 || (telemetry.current || 0) > 0 || (telemetry.currentL1 || 0) > 0;
    const sessionStatus = (act.status === "Finishing" || act.status === "Completed")
      ? act.status
      : (isActivelyPowering ? "Charging" : (act.status || "Charging"));

    updates[`${txBase}/transactionId`] = resolvedTxId;
    updates[`${txBase}/status`] = sessionStatus;
    updates[`${txBase}/currentPowerKw`] = telemetry.powerKw || 0;
    updates[`${txBase}/currentEnergyWh`] = telemetry.energyWh || (telemetry.energyKwh ? Math.round(telemetry.energyKwh * 1000) : 0);
    updates[`${txBase}/energyDeliveredWh`] = sessionEnergyWh;
    updates[`${txBase}/energyDeliveredKwh`] = sessionEnergyKwh;
    updates[`${txBase}/cost`] = liveCost;
    updates[`${txBase}/lastTelemetryAt`] = nowIso();

    // Mirror activeTx into connectors/{targetConnId}/activeTx in RTDB as well
    updates[livePath(chargePointId, "connectors", targetConnId, "activeTx")] = {
      transactionId: resolvedTxId,
      status: sessionStatus,
      meterStart: mStart,
      currentPowerKw: telemetry.powerKw || 0,
      currentEnergyWh: telemetry.energyWh || 0,
      energyDeliveredKwh: sessionEnergyKwh,
      energyDeliveredWh: sessionEnergyWh,
      cost: liveCost,
      updatedAt: nowIso(),
    };

    if (typeof telemetry.soc === 'number' && telemetry.soc > 0) {
      updates[`${txBase}/soc`] = telemetry.soc;
      updates[`${txBase}/socCurrent`] = telemetry.soc;
      // Capture the first valid non-zero BMS battery percentage
      if (act.socStart === undefined || act.socStart === null || act.socStart === 0) {
        updates[`${txBase}/socStart`] = telemetry.soc;
      }

      // Push Notification: Whenever SoC increases by a 10% milestone (e.g. 30%, 40%, 50%, 60%, 70%, 80%, 90%, 100%)
      const currentSoc = Math.floor(telemetry.soc);
      const lastNotifiedSoc = act.lastNotifiedSoc || act.socStart || 0;
      if (currentSoc >= 10 && currentSoc >= lastNotifiedSoc + 10) {
        updates[`${txBase}/lastNotifiedSoc`] = currentSoc;
        getSubscribedPushTokens(chargePointId).then((tokens) => {
          const gunName = targetConnId === 2 ? "Gun B" : "Gun A";
          sendPushNotification(tokens, {
            title: `🔋 Battery at ${currentSoc}%`,
            body: `${gunName} vehicle reached ${currentSoc}% battery (+${currentSoc - lastNotifiedSoc}% gained).`,
            data: { chargePointId, connectorId: targetConnId, soc: currentSoc },
          });
        });
      }
    }

    // Live update to Firestore transaction record so energy & cost are always accurate
    try {
      const txUpdates = {
        energyDeliveredKwh: sessionEnergyKwh,
        energyDeliveredWh: sessionEnergyWh,
        cost: liveCost,
        currentPowerKw: telemetry.powerKw || 0,
        currentEnergyWh: telemetry.energyWh || (telemetry.energyKwh ? Math.round(telemetry.energyKwh * 1000) : 0),
        lastTelemetryAt: nowIso(),
      };
      if (typeof telemetry.soc === 'number' && telemetry.soc > 0) {
        txUpdates.socCurrent = telemetry.soc;
        if (act.socStart === undefined || act.socStart === null || act.socStart === 0) {
          txUpdates.socStart = telemetry.soc;
        }
      }
      await updateDoc(doc(db, "transactions", String(resolvedTxId)), txUpdates);
    } catch (_e) {}

    // Dual-write telemetry to Firestore connector (without overwriting connector status)
    try {
      const connDocRef = doc(db, "chargers", chargePointId, "connectors", String(targetConnId));
      await setDoc(
        connDocRef,
        {
          telemetry: {
            ...telemetry,
            energyKwh: sessionEnergyKwh > 0 ? sessionEnergyKwh : (telemetry.energyKwh || 0),
            updatedAt: nowIso(),
          },
          activeTx: {
            transactionId: resolvedTxId,
            status: sessionStatus,
            meterStart: mStart,
            currentPowerKw: telemetry.powerKw || 0,
            currentEnergyWh: telemetry.energyWh || 0,
            energyDeliveredKwh: sessionEnergyKwh,
            energyDeliveredWh: sessionEnergyWh,
            cost: liveCost,
            updatedAt: nowIso(),
          },
          updatedAt: nowIso(),
        },
        { merge: true }
      );
    } catch (_fsErr) {}

    // Single atomic multi-path write to RTDB
    await update(ref(rtdb), updates);

    return {
      resolvedTxId,
      sessionEnergyKwh,
      sessionEnergyWh,
      liveCost,
      powerKw: telemetry.powerKw || 0,
      soc: typeof telemetry.soc === 'number' ? telemetry.soc : null,
      activeTx: act,
      effectiveTariff,
    };
  } catch (err) {
    console.error(`[RTDB Error] saveMeterValues:`, err.message);
    return null;
  }
}

/**
 * Charging session started
 * Firestore: permanent transaction record (1 write). RTDB: live active session.
 */
export async function saveStartTransaction(transactionId, chargePointId, connectorId, idTag, meterStart, timestamp) {
  const startTime = timestamp || nowIso();
  try {
    // Check if a driver app user started this session
    let userId = null;
    let userEmail = null;
    let targetKwh = null;
    let targetPrice = null;
    let targetMinutes = null;
    let limitMode = 'full';
    let limitValue = null;
    let effectiveTariff = 125;
    let socStart = null;

    try {
      const chargerDoc = await getDoc(doc(db, "chargers", chargePointId));
      if (chargerDoc.exists() && chargerDoc.data().tariffRate) {
        effectiveTariff = Number(chargerDoc.data().tariffRate);
      }
    } catch (_e) {}

    try {
      const snap = await get(ref(rtdb, livePath(chargePointId, "activeTx", connectorId)));
      if (snap.exists()) {
        const val = snap.val();
        if (val.userId) userId = val.userId;
        if (val.userEmail) userEmail = val.userEmail;
        if (val.targetKwh) targetKwh = Number(val.targetKwh);
        if (val.targetPrice) targetPrice = Number(val.targetPrice);
        if (val.targetMinutes) targetMinutes = Number(val.targetMinutes);
        if (val.limitMode) limitMode = val.limitMode;
        if (val.limitValue) limitValue = Number(val.limitValue);
        if (typeof val.socStart === 'number' && val.socStart > 0) socStart = val.socStart;
      }
    } catch (_e) {}

    try {
      if (socStart === null || socStart === 0) {
        const connSnap = await get(ref(rtdb, livePath(chargePointId, "connectors", connectorId, "telemetry")));
        if (connSnap.exists() && typeof connSnap.val()?.soc === 'number' && connSnap.val().soc > 0) {
          socStart = connSnap.val().soc;
        }
      }
    } catch (_e) {}

    try {
      const fsConn = await getDoc(doc(db, "chargers", chargePointId, "connectors", String(connectorId)));
      if (fsConn.exists()) {
        const cData = fsConn.data();
        if (socStart === null && typeof cData?.telemetry?.soc === 'number') {
          socStart = cData.telemetry.soc;
        }
        if (!userId && cData?.activeTx?.userId) userId = cData.activeTx.userId;
        if (!userEmail && cData?.activeTx?.userEmail) userEmail = cData.activeTx.userEmail;
        if (!targetKwh && cData?.activeTx?.targetKwh) targetKwh = Number(cData.activeTx.targetKwh);
        if (!targetPrice && cData?.activeTx?.targetPrice) targetPrice = Number(cData.activeTx.targetPrice);
        if (!targetMinutes && cData?.activeTx?.targetMinutes) targetMinutes = Number(cData.activeTx.targetMinutes);
        if (!limitValue && cData?.activeTx?.limitValue) limitValue = Number(cData.activeTx.limitValue);
        if (cData?.activeTx?.limitMode) limitMode = cData.activeTx.limitMode;
      }
    } catch (_e) {}

    // Derive target limits from limitMode if needed
    if (limitMode === 'price') {
      if (!targetPrice && limitValue) targetPrice = Number(limitValue);
      if (targetPrice && (!targetKwh || targetKwh <= 0) && effectiveTariff > 0) {
        targetKwh = Number((targetPrice / effectiveTariff).toFixed(3));
      }
    } else if (limitMode === 'time') {
      if (!targetMinutes && limitValue) targetMinutes = Number(limitValue);
      if (targetMinutes && (!targetKwh || targetKwh <= 0)) {
        targetKwh = Number(((11 * targetMinutes) / 60).toFixed(2));
      }
    } else if (limitMode === 'energy') {
      if (!targetKwh && limitValue) targetKwh = Number(limitValue);
    }

    // Fallback: If idTag is an email address, treat as userEmail
    if (!userEmail && idTag && idTag.includes("@")) {
      userEmail = idTag;
    }

    // Fallback: If userEmail is known, look up userId
    if (!userId && userEmail) {
      try {
        const uQuery = query(collection(db, "users"), where("email", "==", userEmail), limit(1));
        const uSnap = await getDocs(uQuery);
        if (!uSnap.empty) {
          userId = uSnap.docs[0].id;
        } else if (userEmail === "telsa@teksa.cok") {
          userId = "XIiBSAyJdugfkuAH9ceTGhgCBSh2";
        }
      } catch (_e) {}
    }

    const txData = {
      transactionId: Number(transactionId),
      chargePointId,
      connectorId: Number(connectorId),
      idTag: idTag || "Anonymous",
      userId: userId || null,
      userEmail: userEmail || null,
      targetKwh: targetKwh ? Number(targetKwh) : null,
      targetPrice: targetPrice ? Number(targetPrice) : null,
      targetMinutes: targetMinutes ? Number(targetMinutes) : null,
      limitMode: limitMode || 'full',
      limitValue: limitValue ? Number(limitValue) : null,
      meterStart: Number(meterStart),
      tariffRate: effectiveTariff,
      socStart: typeof socStart === 'number' ? socStart : null,
      socCurrent: typeof socStart === 'number' ? socStart : null,
      socStop: null,
      startTime,
      status: "Charging",
      paymentStatus: "Pending",
      paid: false,
      cost: 0,
      energyDeliveredKwh: 0,
      createdAt: nowIso(),
    };

    await setDoc(doc(db, "transactions", String(transactionId)), txData);
    saveLocalServerTransaction(txData);

    const activeTxPayload = {
      ...txData,
      currentPowerKw: 0,
      currentEnergyWh: Number(meterStart) || 0,
    };

    await update(ref(rtdb), {
      [livePath(chargePointId, "activeTx", connectorId)]: activeTxPayload,
      [livePath(chargePointId, "connectors", connectorId, "activeTx")]: activeTxPayload,
    });

    // Update connector doc in Firestore so both RTDB and Firestore have activeTx and meterStart
    await setDoc(
      doc(db, "chargers", chargePointId, "connectors", String(connectorId)),
      {
        status: "Charging",
        activeTx: txData,
        updatedAt: nowIso(),
      },
      { merge: true }
    );

    await saveConnectorStatus(chargePointId, connectorId, "Charging", "NoError", `Transaction #${transactionId}`);
    console.log(`[Hybrid] Started transaction #${transactionId} for charger ${chargePointId} [Limit: ${limitMode} (${limitValue || 'unlimited'})] (User: ${userEmail || userId || 'Anonymous'})`);
  } catch (err) {
    console.error(`[Hybrid Error] saveStartTransaction:`, err.message);
  }
}

/**
 * Find the live active session (and its connector) for a transaction id in RTDB
 */
async function findActiveTx(chargePointId, transactionId) {
  try {
    const snap = await get(ref(rtdb, livePath(chargePointId, "activeTx")));
    if (!snap.exists()) return null;
    const all = snap.val() || {};
    for (const [connId, tx] of Object.entries(all)) {
      if (tx && String(tx.transactionId) === String(transactionId)) {
        return { connectorId: connId, tx };
      }
    }
  } catch (_e) {
    // fall through
  }
  return null;
}

/**
 * Charging session stopped
 * Firestore: final permanent record (1 write, read only if RTDB lacks meterStart).
 * RTDB: clears the active session and publishes lastCompletedTx so apps can update
 *       their local history cache without reading Firestore.
 */
export async function saveStopTransaction(transactionId, chargePointId, meterStop, timestamp, reason, pricePerKwh = null) {
  try {
    const txRef = doc(db, "transactions", String(transactionId));
    const live = await findActiveTx(chargePointId, transactionId);

    let meterStart = 0;
    let base = {};
    if (live?.tx) {
      meterStart = Number(live.tx.meterStart) || 0;
      base = live.tx;
    } else {
      // Fallback: server restarted mid-session and RTDB entry is missing
      const txSnap = await getDoc(txRef);
      if (txSnap.exists()) {
        base = txSnap.data();
        meterStart = base.meterStart || 0;
      }
    }

    // Determine effective tariff rate (PKR per kWh)
    let effectivePrice = Number(pricePerKwh);
    if (!effectivePrice || effectivePrice <= 0) {
      try {
        const chargerSnap = await getDoc(doc(db, "chargers", chargePointId));
        if (chargerSnap.exists()) {
          effectivePrice = Number(chargerSnap.data().tariffRate) || 125;
        } else {
          effectivePrice = 125;
        }
      } catch (_e) {
        effectivePrice = 125;
      }
    }

    const energyDeliveredWh = Math.max(0, Number(meterStop) - Number(meterStart));
    const energyDeliveredKwh = Number((energyDeliveredWh / 1000).toFixed(2));
    const totalCost = Number((energyDeliveredKwh * effectivePrice).toFixed(2));
    const stopTime = timestamp || nowIso();

    // Determine start and stop battery percentage (SoC) - strictly non-zero
    let socStart = typeof live?.tx?.socStart === 'number' && live.tx.socStart > 0
      ? live.tx.socStart
      : (typeof base?.socStart === 'number' && base.socStart > 0 ? base.socStart : null);
    let socStop = typeof live?.tx?.socCurrent === 'number' && live.tx.socCurrent > 0
      ? live.tx.socCurrent
      : (typeof live?.tx?.soc === 'number' && live.tx.soc > 0
        ? live.tx.soc
        : (typeof base?.socCurrent === 'number' && base.socCurrent > 0 ? base.socCurrent : null));

    const connIdNum = base.connectorId ?? live?.connectorId ?? 1;

    try {
      const connSnap = await get(ref(rtdb, livePath(chargePointId, "connectors", connIdNum, "telemetry")));
      if (connSnap.exists() && typeof connSnap.val()?.soc === 'number' && connSnap.val().soc > 0) {
        socStop = connSnap.val().soc;
        if (socStart === null || socStart === 0) socStart = connSnap.val().soc;
      }
    } catch (_e) {}

    try {
      if (socStop === null || socStart === null || socStart === 0) {
        const fsConn = await getDoc(doc(db, "chargers", chargePointId, "connectors", String(connIdNum)));
        if (fsConn.exists() && typeof fsConn.data()?.telemetry?.soc === 'number' && fsConn.data().telemetry.soc > 0) {
          const s = fsConn.data().telemetry.soc;
          if (socStop === null) socStop = s;
          if (socStart === null || socStart === 0) socStart = s;
        }
      }
    } catch (_e) {}

    const socGained = typeof socStart === 'number' && socStart > 0 && typeof socStop === 'number' && socStop > 0
      ? Math.max(0, socStop - socStart)
      : null;

    const finalFields = {
      stopTime,
      meterStop: Number(meterStop),
      energyDeliveredWh,
      energyDeliveredKwh,
      cost: totalCost,
      tariffRate: effectivePrice,
      socStart: typeof socStart === 'number' ? socStart : null,
      socStop: typeof socStop === 'number' ? socStop : null,
      socGained,
      status: "Completed",
      paymentStatus: "Pending",
      reason: reason || "Local",
      updatedAt: nowIso(),
    };

    await setDoc(txRef, finalFields, { merge: true });

    // Publish the finished session to RTDB and clear the live session
    const completed = {
      id: String(transactionId),
      transactionId: Number(transactionId),
      chargePointId,
      connectorId: Number(base.connectorId ?? live?.connectorId ?? 1),
      idTag: base.idTag || "Anonymous",
      meterStart: Number(meterStart),
      startTime: base.startTime || null,
      ...finalFields,
    };
    await set(ref(rtdb, livePath(chargePointId, "lastCompletedTx")), completed);
    saveLocalServerTransaction(completed);
    const connIdStr = String(base.connectorId ?? live?.connectorId ?? 1);
    const targetConnKey = live?.connectorId || connIdStr;

    await update(ref(rtdb), {
      [livePath(chargePointId, "activeTx", targetConnKey)]: null,
      [livePath(chargePointId, "connectors", targetConnKey, "activeTx")]: null,
      [livePath(chargePointId, "connectors", targetConnKey, "status")]: "Available",
      [livePath(chargePointId, "connectors", targetConnKey, "info")]: "",
    });

    await setDoc(
      doc(db, "chargers", chargePointId, "connectors", connIdStr),
      {
        status: "Available",
        activeTx: deleteField(),
        updatedAt: nowIso(),
      },
      { merge: true }
    ).catch(() => {});

    await setDoc(
      doc(db, "chargers", chargePointId),
      {
        [`connector_${connIdStr}_status`]: "Available",
        updatedAt: nowIso(),
      },
      { merge: true }
    ).catch(() => {});

    // Push Notification: When charging session has completed / stopped
    getSubscribedPushTokens(chargePointId).then((tokens) => {
      const gunName = Number(connIdStr) === 2 ? "Gun B" : "Gun A";
      const socGainText = socGained ? ` (${socGained}% gained)` : "";
      sendPushNotification(tokens, {
        title: "🛑 Charging Completed",
        body: `${gunName} finished: ${energyDeliveredKwh} kWh delivered${socGainText} for PKR ${totalCost}.`,
        data: {
          chargePointId,
          transactionId,
          energyDeliveredKwh,
          cost: totalCost,
          status: "Completed",
        },
      });
    });

    console.log(
      `[Hybrid] Stopped transaction #${transactionId}: ${energyDeliveredKwh} kWh delivered, SoC: ${socStart ?? '--'}% -> ${socStop ?? '--'}%, Total: PKR ${totalCost}`
    );
    return {
      energyDeliveredKwh,
      totalCost,
      connectorId: Number(base.connectorId ?? live?.connectorId ?? 1),
    };
  } catch (err) {
    console.error(`[Hybrid Error] saveStopTransaction:`, err.message);
    return { energyDeliveredKwh: 0, totalCost: 0, connectorId: 1 };
  }
}

/**
 * Update transaction payment status (e.g. from bank webhook) -> Firestore (permanent)
 */
export async function updateTransactionPayment(transactionId, paymentStatus = "Paid", bankRef = "") {
  try {
    await setDoc(
      doc(db, "transactions", String(transactionId)),
      {
        paymentStatus,
        paid: paymentStatus === "Paid",
        bankReference: bankRef,
        paidAt: nowIso(),
      },
      { merge: true }
    );
    console.log(`[Firestore] Transaction #${transactionId} marked as ${paymentStatus}`);
  } catch (err) {
    console.error(`[Firestore Error] updateTransactionPayment:`, err.message);
  }
}

/**
 * Full live state of a charger.
 * Hardware/setup info from Firestore (1 read), everything live from RTDB.
 */
export async function getChargerLiveState(chargePointId) {
  try {
    const [chargerSnap, liveSnap] = await Promise.all([
      getDoc(doc(db, "chargers", chargePointId)),
      get(ref(rtdb, livePath(chargePointId))),
    ]);

    const chargerInfo = chargerSnap.exists() ? chargerSnap.data() : {};
    const live = liveSnap.exists() ? liveSnap.val() : {};

    const activeTxMap = live.activeTx || {};
    const activeTransaction = Object.values(activeTxMap)[0] || null;

    return {
      charger: {
        ...chargerInfo,
        status: live.status || "Offline",
        lastHeartbeat: live.lastHeartbeat || chargerInfo.lastHeartbeat || null,
      },
      connectors: live.connectors || {},
      activeTransaction,
      activeTransactions: activeTxMap,
      lastCompletedTx: live.lastCompletedTx || null,
    };
  } catch (err) {
    console.error(`[Hybrid Error] getChargerLiveState:`, err.message);
    return { charger: null, connectors: {}, activeTransaction: null, error: err.message };
  }
}

/**
 * Verify whether an RFID / NFC tag is authorized for this charger
 */
export async function verifyRfidTag(chargePointId, idTag) {
  const cleanTag = String(idTag || "").trim().toUpperCase();
  if (!cleanTag) return { status: "Invalid" };

  try {
    // 1. Check charger-specific authorized tags in Firestore
    const chargerTagSnap = await getDoc(
      doc(db, "chargers", chargePointId, "rfidTags", cleanTag)
    );
    if (chargerTagSnap.exists()) {
      const data = chargerTagSnap.data();
      if (data.status === "Blocked") {
        console.warn(`[OCPP Authorize] Tag ${cleanTag} is BLOCKED for ${chargePointId}`);
        return { status: "Blocked" };
      }
      console.log(`[OCPP Authorize] Tag ${cleanTag} VERIFIED for ${chargePointId}`);
      return { status: "Accepted", expiryDate: data.expiryDate };
    }

    // 2. Check global authorized tags collection
    const globalTagSnap = await getDoc(doc(db, "authorizedTags", cleanTag));
    if (globalTagSnap.exists()) {
      const data = globalTagSnap.data();
      if (data.status === "Blocked") {
        console.warn(`[OCPP Authorize] Tag ${cleanTag} is globally BLOCKED`);
        return { status: "Blocked" };
      }
      console.log(`[OCPP Authorize] Tag ${cleanTag} VERIFIED (Global)`);
      return { status: "Accepted", expiryDate: data.expiryDate };
    }

    // 3. Fallback: default to Accepted
    return { status: "Accepted" };
  } catch (err) {
    console.error(`[OCPP Authorize] Error validating tag ${cleanTag}:`, err.message);
    return { status: "Accepted" };
  }
}
