// Firebase SDK
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-storage.js";

// Firebase Configuration
const firebaseConfig = {
    apiKey: "AIzaSyDJ6cu30qrIeq9yV_F7Z8U8KXyUirEksdHY",
    authDomain: "caca-dfe6c.firebaseapp.com",
    projectId: "caca-dfe6c",
    storageBucket: "caca-dfe6c.firebasestorage.app",
    messagingSenderId: "468521189141",
    appId: "1:468521189141:web:f4bf8b9b866ea98ea3f31c"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firebase services
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

export default app;
