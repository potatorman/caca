import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-storage.js";

const firebaseConfig = {
    apiKey: "FIREBASE_CONSOLE_API_KEY",
    authDomain: "caca-dfe6.firebaseapp.com",
    projectId: "caca-dfe6",
    storageBucket: "caca-dfe6.firebasestorage.app",
    messagingSenderId: "468521189141",
    appId: "1:468521189141:web:f4bf8b9b866ea98ea3f31c"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

export default app;
