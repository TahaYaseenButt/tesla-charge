import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import dotenv from "dotenv";

dotenv.config();

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || "AIzaSyBkc0CoqaW1Mg5hLl7kpXU3TAURebEWpcg",
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || "fir-85543.firebaseapp.com",
  projectId: process.env.FIREBASE_PROJECT_ID || "fir-85543",
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "fir-85543.firebasestorage.app",
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "572566245138",
  appId: process.env.FIREBASE_APP_ID || "1:572566245138:web:4ba404d2c1ac8788582dcb",
  databaseURL: process.env.FIREBASE_DATABASE_URL || "https://fir-85543-default-rtdb.firebaseio.com",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

console.log(`[Firebase] Initialized connection to Firestore project: ${firebaseConfig.projectId}`);
