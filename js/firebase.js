import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDJ6cu30qrIeq9yV_FZ7U8KXyUirEksdHY",
  authDomain: "caca-dfe6c.firebaseapp.com",
  projectId: "caca-dfe6c",
  storageBucket: "caca-dfe6c.firebasestorage.app",
  messagingSenderId: "468521189141",
  appId: "1:468521189141:web:f4bf8b9b866ea98ea3f31c"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

export default app;
