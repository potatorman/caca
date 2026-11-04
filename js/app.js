import { auth, db } from "./firebase.js";
import { DEFAULT_AVATAR_ID, setAvatarElement } from "./avatars.js";

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

const authView = $("authView");
const appView = $("appView");

const loginForm = $("loginForm");
const registerForm = $("registerForm");

const loginTab = $("loginTab");
const registerTab = $("registerTab");

const authMessage = $("authMessage");

let registrationInProgress = false;

// USERNAME

function validateUsername(value) {
    const username = value.trim();

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
        throw new Error(
            "Kullanıcı adı 3-20 karakter olmalı. İngilizce harf, rakam ve _ kullanabilirsin."
        );
    }

    return username;
}

function usernameToEmail(username) {
    return `${username.toLowerCase()}@caca-dfe6.firebaseapp.com`;
}

// MESSAGES

function showAuthMessage(message, success = false) {
    authMessage.textContent = message;
    authMessage.className = "status-message";

    if (success) {
        authMessage.classList.add("success");
    }
}

function friendlyError(error) {
    console.error(error);

    switch (error.code) {
        case "auth/email-already-in-use":
            return "Bu kullanıcı adı zaten alınmış.";

        case "auth/invalid-credential":
        case "auth/user-not-found":
        case "auth/wrong-password":
            return "Kullanıcı adı veya şifre yanlış.";

        case "auth/weak-password":
            return "Şifre en az 8 karakter olmalı.";

        case "auth/too-many-requests":
            return "Çok fazla deneme yapıldı. Daha sonra tekrar dene.";

        case "auth/network-request-failed":
            return "İnternet bağlantını kontrol et.";

        default:
            return error.message || "Bir hata oluştu.";
    }
}

function setLoading(form, loading, normalText) {
    const button = form.querySelector('button[type="submit"]');

    button.disabled = loading;
    button.textContent = loading
        ? "Lütfen bekle..."
        : normalText;
}

// SHOW DASHBOARD

function showLoggedIn(
    username,
    nickname = username,
    avatarId = DEFAULT_AVATAR_ID,
    avatarData = null
) {

    const displayName = nickname || username;
    const hasDifferentUsername =
        username.trim().toLowerCase() !== displayName.trim().toLowerCase();

    $("welcomeUsername").textContent = displayName;
    $("accountUsername").textContent = hasDifferentUsername
        ? `(${username})`
        : "";
    $("accountUsername").hidden = !hasDifferentUsername;

    setAvatarElement($("userAvatar"), avatarId, avatarData);

    // Hide login screen
    authView.hidden = true;

    // Show dashboard
    appView.hidden = false;

    // Hide left branding panel
    document.body.classList.add("logged-in");

    console.log("CACA: Dashboard opened.");
}

// SHOW LOGIN

function showLoggedOut() {

    authView.hidden = false;

    appView.hidden = true;

    // Restore left branding panel
    document.body.classList.remove("logged-in");

    console.log("CACA: Login screen opened.");
}

// SWITCH LOGIN / REGISTER

function switchMode(mode) {

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

        showAuthMessage("Hesabın oluşturuluyor...", true);

        registrationInProgress = true;

        const credential = await createUserWithEmailAndPassword(
            auth,
            usernameToEmail(username),
            password
        );

        newUser = credential.user;

        await setDoc(
            doc(db, "users", newUser.uid),
            {
                username: username,
                usernameLower: username.toLowerCase(),
                nickname: username,
                createdAt: serverTimestamp()
            }
        );

        registerForm.reset();

        showLoggedIn(username);

    } catch (error) {

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

        showAuthMessage("Giriş yapılıyor...", true);

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

// FIREBASE AUTH STATE

onAuthStateChanged(auth, async (user) => {

    if (registrationInProgress) return;

    if (!user) {

        showLoggedOut();

        return;
    }

    try {

        const userRef = doc(db, "users", user.uid);

        const userSnapshot = await getDoc(userRef);

        if (!userSnapshot.exists()) {
            throw new Error("Kullanıcı profili bulunamadı.");
        }

        const profile = userSnapshot.data();
        showLoggedIn(
            profile.username,
            profile.nickname || profile.username,
            profile.avatarId || DEFAULT_AVATAR_ID,
            profile.avatarData || null
        );

    } catch (error) {

        showAuthMessage(
            "Profil yüklenemedi: " + error.message
        );

        await signOut(auth);
    }
});

// LOGOUT

$("logoutButton").addEventListener("click", async () => {

    try {

        await signOut(auth);

    } catch (error) {

        console.error(error);

        showAuthMessage(friendlyError(error));
    }
});

// Sync the top-bar avatar when the account avatar changes in settings.

document.addEventListener("caca:avatar-changed", (event) => {
    const avatarId = event.detail?.avatarId || DEFAULT_AVATAR_ID;
    const avatarData = event.detail?.avatarData || null;
    setAvatarElement($("userAvatar"), avatarId, avatarData);
});

// INITIAL SCREEN

switchMode("login");
