import { auth, db } from "./firebase.js";
import { AVATARS, DEFAULT_AVATAR_ID, setAvatarElement } from "./avatars.js";
import { UNO_WORKER_URL } from "../games/uno/worker-config.js";

import {
    EmailAuthProvider,
    reauthenticateWithCredential,
    updatePassword,
    deleteUser,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";

import {
    collection,
    doc,
    getDoc,
    getDocs,
    updateDoc,
    writeBatch,
    deleteDoc
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

let currentUsername = "";
let currentNickname = "";
let currentAvatarId = DEFAULT_AVATAR_ID;
let pendingAvatarId = DEFAULT_AVATAR_ID;
let currentAvatarData = null;
let pendingAvatarData = null;
let accountActionInProgress = false;
let settingsReturnToRoom = false;

// MESSAGES

function showSettingsMessage(message, success = false) {
    const element = $("settingsMessage");
    element.textContent = message;
    element.className = "status-message";

    if (success) {
        element.classList.add("success");
    }
}

function friendlySettingsError(error) {
    console.error("CACA settings error:", error);

    switch (error.code) {
        case "auth/invalid-credential":
        case "auth/wrong-password":
            return "Mevcut şifren yanlış.";

        case "auth/requires-recent-login":
            return "Güvenlik nedeniyle tekrar giriş yapman gerekiyor. Çıkış yapıp yeniden giriş yap, sonra tekrar dene.";

        case "auth/weak-password":
            return "Yeni şifre en az 8 karakter olmalı.";

        case "auth/too-many-requests":
            return "Çok fazla deneme yapıldı. Daha sonra tekrar dene.";

        case "auth/network-request-failed":
            return "İnternet bağlantını kontrol et.";

        case "permission-denied":
            return "Firebase izin vermedi. Firestore Rules ayarlarını kontrol et.";

        default:
            return error.message || "Bir hata oluştu.";
    }
}

function setFormLoading(form, loading, buttonText) {
    const button = form.querySelector('button[type="submit"]');
    button.disabled = loading;
    button.textContent = loading ? "İşleniyor..." : buttonText;
}

function reauthenticateUser(user, password) {
    if (!user || !user.email) {
        throw new Error("Hesap bilgileri alınamadı. Tekrar giriş yap.");
    }

    const credential = EmailAuthProvider.credential(user.email, password);
    return reauthenticateWithCredential(user, credential);
}

// Profile photo crop editor. The selected square is finally compressed to 128x128.
const AVATAR_CROP_SIZE = 512;
let pendingAvatarCrop = null;

function getAvatarCropDimensions(state) {
    const baseScale = Math.max(
        AVATAR_CROP_SIZE / state.bitmap.width,
        AVATAR_CROP_SIZE / state.bitmap.height
    );
    const scale = baseScale * state.zoom;
    return {
        width: state.bitmap.width * scale,
        height: state.bitmap.height * scale
    };
}

function clampAvatarCropPosition(state) {
    const size = getAvatarCropDimensions(state);
    state.offsetX = Math.min(0, Math.max(AVATAR_CROP_SIZE - size.width, state.offsetX));
    state.offsetY = Math.min(0, Math.max(AVATAR_CROP_SIZE - size.height, state.offsetY));
}

function drawAvatarCrop() {
    const state = pendingAvatarCrop;
    const canvas = $("avatarCropCanvas");
    if (!state || !canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const size = getAvatarCropDimensions(state);
    clampAvatarCropPosition(state);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#172334";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(state.bitmap, state.offsetX, state.offsetY, size.width, size.height);
}

async function openAvatarCrop(file) {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!file || !allowedTypes.includes(file.type)) {
        throw new Error("JPG, PNG veya WebP formatında bir fotoğraf seç.");
    }
    if (file.size > 10 * 1024 * 1024) {
        throw new Error("Seçtiğin dosya 10 MB'tan küçük olmalı.");
    }
    if (typeof createImageBitmap !== "function") {
        throw new Error("Tarayıcın fotoğraf düzenlemeyi desteklemiyor. Güncel bir tarayıcı kullan.");
    }

    const bitmap = await createImageBitmap(file);
    const baseScale = Math.max(
        AVATAR_CROP_SIZE / bitmap.width,
        AVATAR_CROP_SIZE / bitmap.height
    );
    const width = bitmap.width * baseScale;
    const height = bitmap.height * baseScale;

    pendingAvatarCrop = {
        bitmap,
        zoom: 1,
        offsetX: (AVATAR_CROP_SIZE - width) / 2,
        offsetY: (AVATAR_CROP_SIZE - height) / 2,
        drag: null
    };

    $("avatarCropZoom").value = "1";
    $("avatarCropDialog").hidden = false;
    drawAvatarCrop();
    $("cancelAvatarCropButton").focus();
}

function closeAvatarCrop() {
    if (pendingAvatarCrop?.bitmap) {
        pendingAvatarCrop.bitmap.close?.();
    }
    pendingAvatarCrop = null;
    const dialog = $("avatarCropDialog");
    if (dialog) dialog.hidden = true;
    const canvas = $("avatarCropCanvas");
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
}

async function createProfilePhotoData(cropCanvas) {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Fotoğraf düzenleyici başlatılamadı.");

    context.fillStyle = "#172334";
    context.fillRect(0, 0, 128, 128);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(cropCanvas, 0, 0, 128, 128);

    let quality = 0.82;
    let dataUrl = canvas.toDataURL("image/jpeg", quality);
    while (dataUrl.length > 85000 && quality > 0.42) {
        quality -= 0.1;
        dataUrl = canvas.toDataURL("image/jpeg", quality);
    }
    if (dataUrl.length > 90000) {
        throw new Error("Fotoğraf sıkıştırılamadı. Daha küçük bir fotoğraf dene.");
    }
    return dataUrl;
}

function cancelAvatarCrop() {
    closeAvatarCrop();
    accountActionInProgress = false;
    renderAvatarPicker();
    $("avatarSaveMessage").textContent = "Fotoğraf kadrajı iptal edildi.";
    $("avatarSaveMessage").className = "avatar-save-status";
}

async function saveAvatarCrop() {
    const state = pendingAvatarCrop;
    if (!state || !accountActionInProgress) return;
    const button = $("saveAvatarCropButton");
    button.disabled = true;
    button.textContent = "Hazırlanıyor...";
    $("avatarSaveMessage").textContent = "Fotoğraf 128×128 boyutuna hazırlanıyor...";
    $("avatarSaveMessage").className = "avatar-save-status saving";

    try {
        pendingAvatarData = await createProfilePhotoData($("avatarCropCanvas"));
        closeAvatarCrop();
        accountActionInProgress = false;
        renderAvatarPicker();
        $("avatarSaveMessage").textContent =
            "Kadraj hazır. Profiline uygulamak için Değişikliği kaydet'e bas.";
        $("avatarSaveMessage").className = "avatar-save-status";
    } catch (error) {
        console.error("CACA profile photo crop failed:", error);
        $("avatarSaveMessage").textContent = error.message || "Fotoğraf hazırlanamadı.";
        $("avatarSaveMessage").className = "avatar-save-status error";
    } finally {
        if (!$("avatarCropDialog").hidden) {
            button.disabled = false;
            button.textContent = "Kadrajı kullan";
        }
    }
}

const avatarCropCanvas = $("avatarCropCanvas");
avatarCropCanvas.addEventListener("pointerdown", (event) => {
    if (!pendingAvatarCrop) return;
    const state = pendingAvatarCrop;
    state.drag = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        offsetX: state.offsetX,
        offsetY: state.offsetY
    };
    avatarCropCanvas.setPointerCapture(event.pointerId);
});
avatarCropCanvas.addEventListener("pointermove", (event) => {
    const state = pendingAvatarCrop;
    if (!state?.drag || state.drag.pointerId !== event.pointerId) return;
    const rect = avatarCropCanvas.getBoundingClientRect();
    state.offsetX = state.drag.offsetX +
        (event.clientX - state.drag.clientX) * avatarCropCanvas.width / rect.width;
    state.offsetY = state.drag.offsetY +
        (event.clientY - state.drag.clientY) * avatarCropCanvas.height / rect.height;
    drawAvatarCrop();
});
["pointerup", "pointercancel", "lostpointercapture"].forEach((eventName) => {
    avatarCropCanvas.addEventListener(eventName, () => {
        if (pendingAvatarCrop) pendingAvatarCrop.drag = null;
    });
});

$("avatarCropZoom").addEventListener("input", (event) => {
    const state = pendingAvatarCrop;
    if (!state) return;
    const oldSize = getAvatarCropDimensions(state);
    const centerRatioX = (AVATAR_CROP_SIZE / 2 - state.offsetX) / oldSize.width;
    const centerRatioY = (AVATAR_CROP_SIZE / 2 - state.offsetY) / oldSize.height;
    state.zoom = Math.min(3, Math.max(1, Number(event.target.value) || 1));
    const newSize = getAvatarCropDimensions(state);
    state.offsetX = AVATAR_CROP_SIZE / 2 - centerRatioX * newSize.width;
    state.offsetY = AVATAR_CROP_SIZE / 2 - centerRatioY * newSize.height;
    drawAvatarCrop();
});
$("cancelAvatarCropButton").addEventListener("click", cancelAvatarCrop);
$("saveAvatarCropButton").addEventListener("click", saveAvatarCrop);

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || $("avatarCropDialog").hidden) return;
    event.preventDefault();
    cancelAvatarCrop();
});

// Close the cropper when the user leaves the account settings view.
$("backFromSettings").addEventListener("click", () => {
    if (!$("avatarCropDialog").hidden) cancelAvatarCrop();
}, { capture: true });

// Keep the selected emoji/photo and its accessible state in sync.
// Keep the selected emoji/photo and its accessible state in sync.
function renderAvatarPicker() {
    const selectedAvatar = AVATARS[pendingAvatarId] || AVATARS[DEFAULT_AVATAR_ID];
    $("avatarPickerCurrent").textContent =
        pendingAvatarData ? "Özel fotoğraf" : selectedAvatar.label;

    document.querySelectorAll("#avatarPicker [data-avatar-id]").forEach((button) => {
        const selected =
            !pendingAvatarData && button.dataset.avatarId === pendingAvatarId;

        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", String(selected));
    });

    setAvatarElement($("avatarPickerPreview"), pendingAvatarId, pendingAvatarData);

    const hasChanges =
        pendingAvatarId !== currentAvatarId ||
        pendingAvatarData !== currentAvatarData;

    const saveButton = $("saveAvatarButton");
    saveButton.disabled = accountActionInProgress || !hasChanges;
    saveButton.textContent = hasChanges ? "Değişikliği kaydet" : "Avatar güncel";
}

// SETTINGS NAVIGATION

$("settingsButton").addEventListener("click", () => {
    // Remember whether settings were opened over a live room or the dashboard.
    settingsReturnToRoom = !$("roomView").hidden;

    $("dashboardView").hidden = true;
    // Do not hide the room: the settings view is a visual overlay above it.
    $("settingsView").hidden = false;
    $("backFromSettings").textContent = settingsReturnToRoom
        ? "← Sohbete dön"
        : "← Odalarıma dön";

    showSettingsMessage("");
});

$("backFromSettings").addEventListener("click", () => {
    $("settingsView").hidden = true;

    if (settingsReturnToRoom && !$("roomView").hidden) {
        $("dashboardView").hidden = true;
        $("roomView").hidden = false;
    } else {
        $("roomView").hidden = true;
        $("dashboardView").hidden = false;
    }

    settingsReturnToRoom = false;
    showSettingsMessage("");
});

// SITE OWNER ACTIVATION
function renderOwnerActivationState(isOwner) {
    $("ownerActivationActive").hidden = !isOwner;
    $("ownerActivationForm").hidden = isOwner;
}

$("ownerActivationForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (accountActionInProgress) return;

    const user = auth.currentUser;
    const code = $("ownerActivationCode").value.trim();
    if (!user) {
        showSettingsMessage("Oturumun sona ermiş. Tekrar giriş yap.");
        return;
    }
    if (!/^[A-Za-z0-9_-]{16}$/.test(code)) {
        showSettingsMessage("Kurulum kodu 16 karakterli olmalı.");
        return;
    }

    const button = $("ownerActivationButton");
    accountActionInProgress = true;
    button.disabled = true;
    button.textContent = "Etkinleştiriliyor...";
    showSettingsMessage("");

    try {
        const idToken = await user.getIdToken();
        const response = await fetch(UNO_WORKER_URL + "/api/site-owner/claim", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + idToken,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ setupCode: code })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.error || "Site Owner yetkisi etkinleştirilemedi.");
        }

        $("ownerActivationCode").value = "";
        renderOwnerActivationState(true);
        showSettingsMessage("Site Owner yetkisi etkinleştirildi.", true);
        document.dispatchEvent(new CustomEvent("caca:site-owner-activated"));
    } catch (error) {
        showSettingsMessage("Site Owner etkinleştirilemedi: " + friendlySettingsError(error));
    } finally {
        accountActionInProgress = false;
        button.disabled = false;
        button.textContent = "Site Owner olarak etkinleştir";
    }
});

// LOAD PROFILE

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        currentUsername = "";
        currentNickname = "";
        currentAvatarId = DEFAULT_AVATAR_ID;
        pendingAvatarId = DEFAULT_AVATAR_ID;
        currentAvatarData = null;
        pendingAvatarData = null;
        $("settingsUsername").value = "";
        $("nicknameInput").value = "";
        renderOwnerActivationState(false);
        renderAvatarPicker();
        return;
    }

    try {
        const profileSnapshot = await getDoc(doc(db, "users", user.uid));

        if (!profileSnapshot.exists()) {
            throw new Error("Kullanıcı profili bulunamadı.");
        }

        const profile = profileSnapshot.data();
        renderOwnerActivationState(profile.siteRole === "site_owner");
        currentUsername = profile.username || "";
        currentNickname = profile.nickname || currentUsername;
        currentAvatarId = AVATARS[profile.avatarId] ? profile.avatarId : DEFAULT_AVATAR_ID;
        pendingAvatarId = currentAvatarId;
        currentAvatarData =
            typeof profile.avatarData === "string" ? profile.avatarData : null;
        pendingAvatarData = currentAvatarData;

        $("settingsUsername").value = currentUsername;
        $("nicknameInput").value = currentNickname;
        renderAvatarPicker();
    } catch (error) {
        showSettingsMessage("Profil bilgileri yüklenemedi: " + friendlySettingsError(error));
    }
});

// SELECT PROFILE AVATAR

$("avatarPicker").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-avatar-id]");
    if (!button || accountActionInProgress) return;

    const avatarId = button.dataset.avatarId;
    if (!AVATARS[avatarId]) return;

    pendingAvatarId = avatarId;
    pendingAvatarData = null;
    renderAvatarPicker();

    const status = $("avatarSaveMessage");
    if (
        pendingAvatarId === currentAvatarId &&
        pendingAvatarData === currentAvatarData
    ) {
        status.textContent = "Kayıtlı avatarın seçili.";
        status.className = "avatar-save-status";
    } else {
        status.textContent = "Seçimin hazır. Değişikliği uygulamak için kaydet'e bas.";
        status.className = "avatar-save-status";
    }
});


// CHOOSE AND COMPRESS A CUSTOM PROFILE PHOTO

$("avatarImageInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file || accountActionInProgress) return;

    const status = $("avatarSaveMessage");
    accountActionInProgress = true;
    renderAvatarPicker();
    status.textContent = "Fotoğraf kadraj düzenleyicisi açılıyor...";
    status.className = "avatar-save-status saving";

    try {
        await openAvatarCrop(file);
    } catch (error) {
        console.error("CACA profile photo crop open failed:", error);
        accountActionInProgress = false;
        renderAvatarPicker();
        status.textContent = error.message || "Fotoğraf açılamadı.";
        status.className = "avatar-save-status error";
    } finally {
        $("avatarImageInput").value = "";
    }
});

// SAVE PROFILE AVATAR

function publishAvatarChange(avatarId, avatarData = null) {
    document.dispatchEvent(
        new CustomEvent("caca:avatar-changed", {
            detail: { avatarId, avatarData }
        })
    );
}

$("saveAvatarButton").addEventListener("click", async () => {
    const hasChanges =
        pendingAvatarId !== currentAvatarId ||
        pendingAvatarData !== currentAvatarData;

    if (accountActionInProgress || !hasChanges) return;

    const user = auth.currentUser;
    if (!user) {
        const status = $("avatarSaveMessage");
        status.textContent = "Oturum bulunamadı. Tekrar giriş yap.";
        status.className = "avatar-save-status error";
        return;
    }

    const previousAvatarId = currentAvatarId;
    const previousAvatarData = currentAvatarData;
    const nextAvatarId = pendingAvatarId;
    const nextAvatarData = pendingAvatarData;

    if (!AVATARS[nextAvatarId]) return;

    accountActionInProgress = true;
    renderAvatarPicker();

    const status = $("avatarSaveMessage");
    status.textContent = "Avatar kaydediliyor...";
    status.className = "avatar-save-status saving";

    // Show the new avatar immediately. Roll it back if Firestore rejects
    // the update, so the interface never silently displays an unsaved choice.
    currentAvatarId = nextAvatarId;
    currentAvatarData = nextAvatarData;
    publishAvatarChange(nextAvatarId, nextAvatarData);

    try {
        await updateDoc(doc(db, "users", user.uid), {
            avatarId: nextAvatarId,
            avatarData: nextAvatarData
        });

        status.textContent = nextAvatarData
            ? "Profil fotoğrafın kaydedildi."
            : `${AVATARS[nextAvatarId].label} avatarın kaydedildi.`;
        status.className = "avatar-save-status success";
        showSettingsMessage("Profil avatarın güncellendi.", true);
    } catch (error) {
        console.error("CACA avatar save failed:", error);

        currentAvatarId = previousAvatarId;
        pendingAvatarId = previousAvatarId;
        currentAvatarData = previousAvatarData;
        pendingAvatarData = previousAvatarData;
        renderAvatarPicker();
        publishAvatarChange(previousAvatarId, previousAvatarData);

        const detail = error.code
            ? `${error.code}: ${error.message || "İzin veya bağlantı hatası"}`
            : (error.message || "Bilinmeyen hata");

        status.textContent = "Avatar kaydedilemedi — " + detail;
        status.className = "avatar-save-status error";
        showSettingsMessage("Avatar kaydedilemedi. Ayrıntı avatar seçiminin altında gösteriliyor.");
    } finally {
        accountActionInProgress = false;
        renderAvatarPicker();
    }
});

// CHANGE NICKNAME

$("nicknameForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const form = event.currentTarget;
    const buttonText = "Nickname'i kaydet";

    if (accountActionInProgress) return;

    const user = auth.currentUser;
    const nickname = $("nicknameInput").value.trim();

    if (!user) {
        showSettingsMessage("Oturumun sona ermiş. Tekrar giriş yap.");
        return;
    }

    if (nickname.length < 2 || nickname.length > 24) {
        showSettingsMessage("Nickname 2-24 karakter arasında olmalı.");
        return;
    }

    if (nickname === currentNickname) {
        showSettingsMessage("Bu nickname zaten kullanılıyor.");
        return;
    }

    accountActionInProgress = true;
    setFormLoading(form, true, buttonText);

    try {
        const roomList = await getDocs(
            collection(db, "users", user.uid, "rooms")
        );

        const memberReferences = [];

        // Collect this account's membership documents. Updating them
        // makes the new nickname appear in every room immediately.
        for (const roomEntry of roomList.docs) {
            const memberRef = doc(
                db,
                "rooms",
                roomEntry.id,
                "members",
                user.uid
            );

            const memberSnapshot = await getDoc(memberRef);
            if (memberSnapshot.exists()) {
                memberReferences.push(memberRef);
            }
        }

        // Keep the nickname update atomic and within Firestore's
        // 500-write batch limit.
        if (memberReferences.length > 490) {
            throw new Error(
                "Çok fazla oda üyeliğin var. Nickname değişikliği için destek gerekiyor."
            );
        }

        const batch = writeBatch(db);

        batch.update(doc(db, "users", user.uid), {
            nickname: nickname
        });

        for (const memberRef of memberReferences) {
            batch.update(memberRef, {
                username: nickname
            });
        }

        await batch.commit();

        currentNickname = nickname;

        const usernameDiffers =
            currentUsername.trim().toLowerCase() !== nickname.trim().toLowerCase();

        $("welcomeUsername").textContent = nickname;
        setAvatarElement($("userAvatar"), currentAvatarId, currentAvatarData);
        $("accountUsername").textContent = usernameDiffers
            ? `(${currentUsername})`
            : "";
        $("accountUsername").hidden = !usernameDiffers;

        document.dispatchEvent(
            new CustomEvent("caca:nickname-changed", {
                detail: { nickname }
            })
        );

        showSettingsMessage("Nickname başarıyla güncellendi.", true);
    } catch (error) {
        showSettingsMessage(
            "Nickname güncellenemedi: " + friendlySettingsError(error)
        );
    } finally {
        accountActionInProgress = false;
        setFormLoading(form, false, buttonText);
    }
});

// CHANGE PASSWORD

$("changePasswordForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const form = event.currentTarget;
    const buttonText = "Şifreyi güncelle";

    if (accountActionInProgress) return;

    const user = auth.currentUser;
    const currentPassword = $("currentPassword").value;
    const newPassword = $("newPassword").value;
    const confirmPassword = $("confirmNewPassword").value;

    if (!user) {
        showSettingsMessage("Oturumun sona ermiş. Tekrar giriş yap.");
        return;
    }

    if (newPassword.length < 8) {
        showSettingsMessage("Yeni şifre en az 8 karakter olmalı.");
        return;
    }

    if (newPassword !== confirmPassword) {
        showSettingsMessage("Yeni şifreler birbiriyle eşleşmiyor.");
        return;
    }

    if (newPassword === currentPassword) {
        showSettingsMessage("Yeni şifren mevcut şifrenle aynı olamaz.");
        return;
    }

    accountActionInProgress = true;
    setFormLoading(form, true, buttonText);

    try {
        await reauthenticateUser(user, currentPassword);
        await updatePassword(user, newPassword);

        form.reset();
        showSettingsMessage("Şifren başarıyla güncellendi.", true);
    } catch (error) {
        showSettingsMessage(friendlySettingsError(error));
    } finally {
        accountActionInProgress = false;
        setFormLoading(form, false, buttonText);
    }
});

// DELETE HELPERS

async function commitDeleteChunks(references, chunkSize = 10) {
    for (let index = 0; index < references.length; index += chunkSize) {
        const batch = writeBatch(db);
        const chunk = references.slice(index, index + chunkSize);

        for (const reference of chunk) {
            batch.delete(reference);
        }

        await batch.commit();
    }
}

async function deleteOwnedRoom(roomId) {
    const roomRef = doc(db, "rooms", roomId);
    const roomSnapshot = await getDoc(roomRef);

    if (!roomSnapshot.exists()) {
        throw new Error("Sahibi olduğun odalardan biri bulunamadı: " + roomId);
    }

    const room = roomSnapshot.data();

    if (room.ownerId !== auth.currentUser.uid) {
        throw new Error("Oda sahipliği doğrulanamadı: " + roomId);
    }

    if (!room.inviteCode) {
        throw new Error("Odanın davet kodu bulunamadı: " + roomId);
    }

    const [membersSnapshot, bansSnapshot, messagesSnapshot, activePrankSnapshot, gameSessionSnapshot] = await Promise.all([
        getDocs(collection(db, "rooms", roomId, "members")),
        getDocs(collection(db, "rooms", roomId, "bans")),
        getDocs(collection(db, "rooms", roomId, "messages")),
        getDoc(doc(db, "rooms", roomId, "pranks", "active")),
        getDoc(doc(db, "rooms", roomId, "gameSessions", "active"))
    ]);

    const referencesToDelete = [];

    membersSnapshot.forEach((memberSnapshot) => {
        referencesToDelete.push(
            doc(db, "rooms", roomId, "prankInbox", memberSnapshot.id)
        );
        if (memberSnapshot.id === auth.currentUser.uid) return;

        referencesToDelete.push(memberSnapshot.ref);
        referencesToDelete.push(
            doc(db, "users", memberSnapshot.id, "rooms", roomId)
        );
    });

    bansSnapshot.forEach((banSnapshot) => {
        referencesToDelete.push(banSnapshot.ref);
    });

    // Delete room messages explicitly; Firestore keeps subcollections
    // when the parent room document is removed.
    messagesSnapshot.forEach((messageSnapshot) => {
        referencesToDelete.push(messageSnapshot.ref);
    });
    if (activePrankSnapshot.exists()) {
        referencesToDelete.push(activePrankSnapshot.ref);
    }
    if (gameSessionSnapshot.exists()) {
        referencesToDelete.push(gameSessionSnapshot.ref);
    }

    await commitDeleteChunks(referencesToDelete, 10);

    // Keep the owner's membership until this final atomic batch.
    const finalBatch = writeBatch(db);

    finalBatch.delete(
        doc(db, "rooms", roomId, "members", auth.currentUser.uid)
    );
    finalBatch.delete(
        doc(db, "users", auth.currentUser.uid, "rooms", roomId)
    );
    finalBatch.delete(doc(db, "roomInvites", room.inviteCode));
    finalBatch.delete(roomRef);

    await finalBatch.commit();
}

async function leaveMemberRoom(roomId, userId) {
    const batch = writeBatch(db);

    batch.delete(doc(db, "rooms", roomId, "members", userId));
    batch.delete(doc(db, "users", userId, "rooms", roomId));
    batch.delete(doc(db, "rooms", roomId, "prankInbox", userId));

    await batch.commit();
}

async function deleteAccountData(user) {
    const roomList = await getDocs(
        collection(db, "users", user.uid, "rooms")
    );

    // Delete every room membership. Owned rooms are removed completely;
    // regular memberships are removed only for this account.
    for (const roomEntry of roomList.docs) {
        const roomId = roomEntry.id;
        const roomData = roomEntry.data();

        if (roomData.role === "owner") {
            await deleteOwnedRoom(roomId);
        } else if (roomData.role === "member") {
            await leaveMemberRoom(roomId, user.uid);
        } else {
            throw new Error("Bilinmeyen oda üyeliği bulundu: " + roomId);
        }
    }

    // Remove the user's Global Chat membership record before deleting the profile.
    await deleteDoc(doc(db, "globalChatMembers", user.uid));

    // Remove the user's private jumpscare library before deleting the profile.
    await deleteDoc(doc(db, "users", user.uid, "jumpscares", "library"));

    // Delete the user's profile after all owned rooms and memberships
    // have been cleaned up. Firestore Rules must allow self-deletion.
    await deleteDoc(doc(db, "users", user.uid));
}

// DELETE ACCOUNT

$("deleteAccountForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const form = event.currentTarget;
    const buttonText = "Hesabımı kalıcı olarak sil";

    if (accountActionInProgress) return;

    const user = auth.currentUser;
    const password = $("deleteAccountPassword").value;
    const confirmation = $("deleteAccountConfirmation").value.trim();

    if (!user) {
        showSettingsMessage("Oturumun sona ermiş. Tekrar giriş yap.");
        return;
    }

    if (confirmation !== "SİL") {
        showSettingsMessage('Devam etmek için onay alanına tam olarak "SİL" yaz.');
        return;
    }

    const confirmed = window.confirm(
        "Hesabın, sahibi olduğun odalar ve bu odaların kayıtları kalıcı olarak silinecek. Devam etmek istiyor musun?"
    );

    if (!confirmed) return;

    accountActionInProgress = true;
    setFormLoading(form, true, buttonText);
    showSettingsMessage("Hesap ve oda kayıtların siliniyor. Bu sırada sayfayı kapatma.", true);

    try {
        // Reauthenticate before deleting any data. Firebase requires a
        // recent sign-in for account deletion.
        await reauthenticateUser(user, password);

        await deleteAccountData(user);

        // Delete the Firebase Authentication account last, while the
        // authenticated session is still available for Firestore writes.
        await deleteUser(user);

        form.reset();
        window.location.reload();
    } catch (error) {
        showSettingsMessage(
            "Hesap silme tamamlanamadı: " + friendlySettingsError(error)
        );
        accountActionInProgress = false;
        setFormLoading(form, false, buttonText);
    }
});
