import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBkc0CoqaW1Mg5hLl7kpXU3TAURebEWpcg",
  authDomain: "fir-85543.firebaseapp.com",
  databaseURL: "https://fir-85543-default-rtdb.firebaseio.com",
  projectId: "fir-85543",
  storageBucket: "fir-85543.firebasestorage.app",
  messagingSenderId: "572566245138",
  appId: "1:572566245138:web:4ba404d2c1ac8788582dcb",
};

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app);
