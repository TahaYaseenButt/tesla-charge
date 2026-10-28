import fs from "fs";
import crypto from "crypto";

const sa = JSON.parse(fs.readFileSync("/Users/teslastudious/Ocpp server/tesla-charge/ocpp-firebase-server/serviceAccountKey.json", "utf8"));

function getJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claimSet = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  })).toString("base64url");

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${claimSet}`);
  const signature = sign.sign(sa.private_key, "base64url");
  return `${header}.${claimSet}.${signature}`;
}

async function getToken() {
  const jwt = getJwt();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const data = await res.json();
  return data.access_token;
}

async function run() {
  const token = await getToken();
  console.log("Got token successfully");
  const rtdbRes = await fetch("https://fir-85543-default-rtdb.firebaseio.com/live/charger1/lastCompletedTx.json?access_token=" + token);
  const data = await rtdbRes.json();
  console.log("RTDB live/charger1/lastCompletedTx:", JSON.stringify(data, null, 2));

  const activeRes = await fetch("https://fir-85543-default-rtdb.firebaseio.com/live/charger1/activeTx.json?access_token=" + token);
  const activeData = await activeRes.json();
  console.log("RTDB live/charger1/activeTx:", JSON.stringify(activeData, null, 2));

  const liveRes = await fetch("https://fir-85543-default-rtdb.firebaseio.com/live/charger1.json?access_token=" + token);
  const liveData = await liveRes.json();
  console.log("RTDB keys in live/charger1:", Object.keys(liveData || {}));
  process.exit(0);
}
run().catch(console.error);
