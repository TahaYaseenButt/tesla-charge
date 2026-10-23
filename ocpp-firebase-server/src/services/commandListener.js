import { db } from "../config/firebase.js";
import { collection, query, where, onSnapshot, doc, updateDoc } from "firebase/firestore";
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

          console.log(`[CommandListener] Received pending command [${action}] for charger [${chargePointId}]`);

          try {
            let result = null;

            if (action === "UnlockConnector") {
              result = await ocppServer.unlockConnector(chargePointId, connectorId || 1);
            } else if (action === "RemoteStopTransaction") {
              result = await ocppServer.remoteStopTransaction(chargePointId, transactionId);
            } else if (action === "RemoteStartTransaction") {
              result = await ocppServer.remoteStartTransaction(chargePointId, connectorId || 1, idTag || "AppUser");
            } else if (action === "Reset") {
              result = await ocppServer.reset(chargePointId, type || "Soft");
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
