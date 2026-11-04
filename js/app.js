import { auth, db } from "./firebase.js";

import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    onAuthStateChanged,
    signOut,
    deleteUser
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";

import {
    doc,
    getDoc,
    setDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

// Elements
const authView = $("authView");
const appView = $("appView");

const loginForm = $("loginForm");
const registerForm = $("registerForm");

const loginTab = $("loginTab");
const registerTab = $("registerTab");

const authMessage = $("authMessage");
const appMessage = $("appMessage");

let currentMode = "login";
let registrationInProgress = false;

// Username rules
function validateUsername(value) {
    const username = value.trim();

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        throw new Error(
            "Kullanıcı adı 3-20 karakter olmalı. İngilizce harf, rakam ve _ kullanabilirsin."
        );
    }

    return username;
}

// Convert username into an internal Firebase email.
// Users never need to enter or see this address.
function usernameToEmail(username) {
    return `${username.toLowerCase()}@caca-dfe6.firebaseapp.com`;
}

// Messages
function showAuthMessage(message, type = "error") {
    authMessage.textContent = message;
    authMessage.className = "status-message";

    if (type === "success") {
        authMessage.classList.add("success");
    }
}

function showAppMessage(message, type = "error") {
    appMessage.textContent = message;
    appMessage.className = "status-message";

    if (type === "success") {
        appMessage.classList.add("success");
    }
}

// Firebase errors
function friendlyError(error) {
    switch (error.code) {
        case "auth/email-already-in-use":
            return "Bu kullanıcı adı zaten alınmış.";

        case "auth/invalid-credential":
        case "auth/user-not-found":
        case "auth/wrong-password":
            return "Kullanıcı adı veya şifre yanlış.";

        case "auth/weak-password":
            return "Şifren çok kısa. En az 8 karakter kullan.";

        case "auth/too-many-requests":
            return "Çok fazla deneme yapıldı. Daha sonra tekrar dene.";

        case "auth/network-request-failed":
            return "İnternet bağlantını kontrol et.";

        case "auth/operation-not-allowed":
            return "Firebase Email/Password girişi etkin değil.";

        case "auth/invalid-api-key":
            return "Firebase API key hatalı. firebase.js dosyasını kontrol et.";

        case "permission-denied":
            return "Firestore izni reddedildi. Database Rules ayarlarını kontrol et.";

        default:
            console.error(error);
            return error.message || "Bir hata oluştu.";
    }
}

// Switch login / register
function switchMode(mode) {
    currentMode = mode;

    const isLogin = mode === "login";

    loginForm.hidden = !isLogin;
    registerForm.hidden = isLogin;

    loginTab.classList.toggle("active", isLogin);
    registerTab.classList.toggle("active", !isLogin);

    $("formHeading").textContent = isLogin
        ? "Tekrar hoş geldin."
        : "Aramıza katıl.";

    $("formDescription").textContent = isLogin
        ? "Hesabına giriş yap ve sohbete devam et."
        : "Yeni hesabını oluştur ve CACA'ya katıl.";

    showAuthMessage("");
}

loginTab.addEventListener("click", () => switchMode("login"));
registerTab.addEventListener("click", () => switchMode("register"));

// Button loading
function setLoading(form, loading, normalText) {
    const button = form.querySelector('button[type="submit"]');

    button.disabled = loading;
    button.textContent = loading ? "Lütfen bekle..." : normalText;
}

// REGISTER
registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    let newUser = null;

    try {
        const username = validateUsername(
            $("registerUsername").value
        );

        const password = $("registerPassword").value;

        if (password.length < 8) {
            throw new Error("Şifre en az 8 karakter olmalı.");
        }

        setLoading(registerForm, true, "Hesap oluştur");

        showAuthMessage("Hesabın oluşturuluyor...", "success");
        registrationInProgress = true;
        const credential = await createUserWithEmailAndPassword(
            auth,
            usernameToEmail(username),
            password
        );

        newUser = credential.user;

        // Save public profile in Firestore.
        await setDoc(doc(db, "users", newUser.uid), {
            username: username,
            usernameLower: username.toLowerCase(),
            createdAt: serverTimestamp()
        });
        $("welcomeUsername").textContent = username;
$("accountUsername").textContent = username;
$("userAvatar").textContent = username.charAt(0).toUpperCase();

authView.hidden = true;
appView.hidden = false;

        showAuthMessage("Hesabın oluşturuldu!", "success");

        registerForm.reset();

    } catch (error) {

        // Roll back the Auth account if profile creation fails.
        if (newUser) {
            try {
                await deleteUser(newUser);
            } catch (rollbackError) {
                console.error("Account rollback failed:", rollbackError);
            }
        }

        showAuthMessage(
            error.code ? friendlyError(error) : error.message
        );

    } finally {
        registrationInProgress = false;
        setLoading(registerForm, false, "Hesap oluştur");
    }
});

// LOGIN
loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
        const username = validateUsername(
            $("loginUsername").value
        );

        const password = $("loginPassword").value;

        setLoading(loginForm, true, "Giriş yap");
        

        showAuthMessage("Giriş yapılıyor...", "success");

        await signInWithEmailAndPassword(
            auth,
            usernameToEmail(username),
            password
        );

        loginForm.reset();

    } catch (error) {

        showAuthMessage(
            error.code ? friendlyError(error) : error.message
        );

    } finally {
        setLoading(loginForm, false, "Giriş yap");
    }
});

// AUTH STATE
onAuthStateChanged(auth, async (user) => {
    if (registrationInProgress) return;
    if (!user) {
        authView.hidden = false;
        appView.hidden = true;
        return;
    }

    try {
        const userRef = doc(db, "users", user.uid);
        const userSnapshot = await getDoc(userRef);

        if (!userSnapshot.exists()) {
            throw new Error("Kullanıcı profili bulunamadı.");
        }

        const userData = userSnapshot.data();
        const username = userData.username;

        $("welcomeUsername").textContent = username;
        $("accountUsername").textContent = username;
        $("userAvatar").textContent = username.charAt(0).toUpperCase();

        authView.hidden = true;
        appView.hidden = false;

    } catch (error) {
        console.error("Profile loading error:", error);
        showAuthMessage("Profil yüklenemedi: " + error.message);
        await signOut(auth);
    }

});

// LOGOUT
$("logoutButton").addEventListener("click", async () => {
    try {
        await signOut(auth);
        showAppMessage("Çıkış yapıldı.", "success");
    } catch (error) {
        showAppMessage(friendlyError(error));
    }
});

// Start with login screen
switchMode("login");
