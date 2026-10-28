import { db, rtdb } from "../config/firebase.js";
import { collection, query, where, onSnapshot, doc, updateDoc, getDocs, limit } from "firebase/firestore";
import { ref, get } from "firebase/database";
import { ocppServer } from "../ocpp/OCPPServer.js";

/**
 * Listen in real time for commands created by the React Mobile App or Web Dashboard
 */
export function startCommandListener() {
  console.log(`[CommandListener] Listening to Firestore collection: 'commands' (status == 'pending')...`);

  const q = query(collection(db, "commands"), where("status", "==", "pending"));

  onSnapshot(
    q,
    async (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === "added") {
          const commandDoc = change.doc;
          const data = commandDoc.data();
          const { chargePointId, action, connectorId, transactionId, type, idTag } = data;
          const safeId = (chargePointId || "").trim().toLowerCase() || "charger1";

          console.log(`[CommandListener] Received pending command [${action}] for charger [${safeId}] by user [${data.userId || data.idTag || 'Unknown'}]`);

          // 1. Immediate lock: Mark as processing to prevent race conditions or double-firing
          await updateDoc(doc(db, "commands", commandDoc.id), {
            status: "processing",
            processingStartedAt: new Date().toISOString(),
          });

          try {
            let result = null;
            const safeKey = (id) => String(id).replace(/[.#$[\]/]/g, "_");

            if (action === "UnlockConnector") {
              // Safety: verify that energy is not actively flowing before physical unlock
              const connSnap = await get(ref(rtdb, `live/${safeKey(safeId)}/connectors/${connectorId || 1}`));
              const connStatus = connSnap.exists() ? connSnap.val()?.status : null;
              if (connStatus === "Charging") {
                throw new Error("Safety Interlock: Cannot unlock cable while electricity is actively flowing. Stop charging session first.");
              }
              result = await ocppServer.unlockConnector(safeId, connectorId || 1);
              if (result?.status === "UnlockFailed") {
                throw new Error("Station reported UnlockFailed: Cable latch could not be released. Relieve tension on cable and retry.");
              }
              if (result?.status === "NotSupported") {
                throw new Error("Station reported UnlockConnector is not electronically supported on this hardware.");
              }
            } else if (action === "RemoteStartTransaction") {
              // Safety Pre-Flight Checks:
              // Check 1: Ensure charger is actually online and connected to WebSocket
              const connectedList = ocppServer.getConnectedChargers();
              const isConnected = connectedList.some((c) => c.chargePointId.toLowerCase() === safeId);
              if (!isConnected) {
                throw new Error(`Safety Interlock: Charger [${safeId}] is offline. Cannot start session.`);
              }

              // Check 2: Verify physical connector status
              const connSnap = await get(ref(rtdb, `live/${safeKey(safeId)}/connectors/${connectorId || 1}`));
              const connData = connSnap.exists() ? connSnap.val() : {};
              const currentStatus = connData.status || "Available";

              if (currentStatus === "Charging") {
                throw new Error(`Safety Interlock: Gun ${connectorId || 1} is already charging another vehicle.`);
              }
              if (currentStatus === "Faulted") {
                throw new Error(`Safety Interlock: Gun ${connectorId || 1} is in a Faulted state (ground fault or hardware error). Unplug and check equipment.`);
              }
              if (currentStatus === "Unavailable") {
                throw new Error(`Safety Interlock: Gun ${connectorId || 1} is currently disabled or undergoing maintenance.`);
              }

              // If the user has a registered RFID card on this charger, use its tag so tapping the card can stop the session seamlessly
              let effectiveIdTag = idTag || "AppUser";
              try {
                const rfidTagsSnap = await getDocs(collection(db, "chargers", safeId, "rfidTags"));
                if (!rfidTagsSnap.empty) {
                  const cardDoc = rfidTagsSnap.docs.find(d => {
                    const data = d.data();
                    return data.status === "Accepted" && (data.createdBy === userEmail || data.userId === userId);
                  }) || rfidTagsSnap.docs[0];
                  if (cardDoc && cardDoc.id) {
                    effectiveIdTag = cardDoc.id;
                    console.log(`[CommandListener] Linked mobile session to registered physical RFID tag: ${effectiveIdTag}`);
                  }
                }
              } catch (_lookupErr) {}

              result = await ocppServer.remoteStartTransaction(safeId, connectorId || 1, effectiveIdTag);
              if (result?.status === "Rejected") {
                throw new Error("Station rejected remote start. Check that the connector is securely inserted into vehicle.");
              }
            } else if (action === "RemoteStopTransaction") {
              // Safety Check: Resolve physical active session on this connector
              let targetTxId = null;
              let sessionOwnerId = null;

              // 1. First priority: Check what transaction is ACTUALLY active on this connector in RTDB
              try {
                const snap = await get(ref(rtdb, `live/${safeKey(safeId)}/activeTx/${connectorId || 1}`));
                if (snap.exists()) {
                  const tx = snap.val();
                  if (tx && tx.transactionId && Number(tx.transactionId) < 1000000000000) {
                    targetTxId = Number(tx.transactionId);
                    console.log(`[CommandListener] Resolved physical active tx from RTDB: #${targetTxId}`);
                  }
                  sessionOwnerId = tx?.userId || null;
                }
              } catch (lookupErr) {
                console.warn(`[CommandListener] Active tx lookup notice:`, lookupErr.message);
              }

              // 2. Second priority: Check what transaction is active on this connector in Firestore
              if (!targetTxId) {
                try {
                  const fsConn = await getDoc(doc(db, "chargers", safeId, "connectors", String(connectorId || 1)));
                  if (fsConn.exists() && fsConn.data()?.activeTx?.transactionId) {
                    const candidate = Number(fsConn.data().activeTx.transactionId);
                    if (candidate < 1000000000000) {
                      targetTxId = candidate;
                      console.log(`[CommandListener] Resolved physical active tx from Firestore connector: #${targetTxId}`);
                    }
                    sessionOwnerId = fsConn.data().activeTx.userId || sessionOwnerId;
                  }
                } catch (fsLookupErr) {
                  console.warn(`[CommandListener] Firestore connector active tx lookup notice:`, fsLookupErr.message);
                }
              }

              // 3. Third priority: Query active Charging transaction in Firestore
              if (!targetTxId) {
                try {
                  const qActive = query(
                    collection(db, "transactions"),
                    where("chargePointId", "==", safeId),
                    where("connectorId", "==", Number(connectorId || 1)),
                    where("status", "==", "Charging"),
                    limit(1)
                  );
                  const qSnap = await getDocs(qActive);
                  if (!qSnap.empty) {
                    const txDoc = qSnap.docs[0].data();
                    const candidate = Number(txDoc.transactionId);
                    if (candidate < 1000000000000) {
                      targetTxId = candidate;
                      console.log(`[CommandListener] Resolved active transactionId from Firestore query: #${targetTxId}`);
                    }
                    sessionOwnerId = txDoc.userId || sessionOwnerId;
                  }
                } catch (fsLookupErr) {
                  console.warn(`[CommandListener] Firestore active tx lookup notice:`, fsLookupErr.message);
                }
              }

              // 4. Fallback to passed transactionId if it is a real numeric OCPP ID (< 10^12)
              if (!targetTxId && transactionId && Number(transactionId) < 1000000000000) {
                targetTxId = Number(transactionId);
              }

              // Multi-user safety: User B cannot stop User A's car (unless admin)
              const callerUserId = data.userId;
              if (callerUserId && sessionOwnerId && callerUserId !== sessionOwnerId && !data.isAdmin) {
                throw new Error("Authorization Interlock: You can only stop your own charging session.");
              }

              if (!targetTxId) {
                throw new Error(`Cannot stop: No active charging transaction found on Gun ${connectorId || 1}.`);
              }

              result = await ocppServer.remoteStopTransaction(safeId, targetTxId);
              if (result?.status === "Rejected") {
                throw new Error("Station rejected remote stop. Session may already be completing.");
              }
              console.log(`[CommandListener] RemoteStopTransaction accepted for tx #${targetTxId} on ${safeId}`);
            } else if (action === "Reset") {
              result = await ocppServer.reset(safeId, type || "Soft");
            } else if (action === "TriggerMessage") {
              result = await ocppServer.triggerMessage(
                safeId,
                data.requestedMessage || "MeterValues",
                connectorId || 1
              );
            } else {
              throw new Error(`Unsupported command action: ${action}`);
            }

            // Mark command as completed in Firestore
            await updateDoc(doc(db, "commands", commandDoc.id), {
              status: "completed",
              result: result || { status: "Success" },
              executedAt: new Date().toISOString(),
            });

            console.log(`[CommandListener] Command [${action}] executed successfully for [${chargePointId}]`);
          } catch (err) {
            console.error(`[CommandListener] Failed executing command [${action}]:`, err.message);

            await updateDoc(doc(db, "commands", commandDoc.id), {
              status: "failed",
              error: err.message,
              executedAt: new Date().toISOString(),
            });
          }
        }
      }
    },
    (error) => {
      console.error("[CommandListener] Firestore snapshot error:", error.message);
    }
  );
}
