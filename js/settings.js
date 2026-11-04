import { auth, db } from "./firebase.js";
import { AVATARS, DEFAULT_AVATAR_ID } from "./avatars.js";

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
let accountActionInProgress = false;

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

// Keep the selected avatar and its accessible state in sync.
function renderAvatarPicker() {
    const selectedAvatar = AVATARS[pendingAvatarId] || AVATARS[DEFAULT_AVATAR_ID];
    $("avatarPickerCurrent").textContent = selectedAvatar.label;

    document.querySelectorAll("#avatarPicker [data-avatar-id]").forEach((button) => {
        const selected = button.dataset.avatarId === pendingAvatarId;
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", String(selected));
    });

    const saveButton = $("saveAvatarButton");
    saveButton.disabled =
        accountActionInProgress || pendingAvatarId === currentAvatarId;
    saveButton.textContent =
        pendingAvatarId === currentAvatarId ? "Avatar güncel" : "Avatarı kaydet";
}

// SETTINGS NAVIGATION

$("settingsButton").addEventListener("click", () => {
    $("dashboardView").hidden = true;
    $("roomView").hidden = true;
    $("settingsView").hidden = false;

    showSettingsMessage("");
    document.dispatchEvent(new Event("caca:open-settings"));
});

$("backFromSettings").addEventListener("click", () => {
    $("settingsView").hidden = true;
    $("roomView").hidden = true;
    $("dashboardView").hidden = false;
    showSettingsMessage("");
});

// LOAD PROFILE

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        currentUsername = "";
        currentNickname = "";
        currentAvatarId = DEFAULT_AVATAR_ID;
        pendingAvatarId = DEFAULT_AVATAR_ID;
        $("settingsUsername").value = "";
        $("nicknameInput").value = "";
        renderAvatarPicker();
        return;
    }

    try {
        const profileSnapshot = await getDoc(doc(db, "users", user.uid));

        if (!profileSnapshot.exists()) {
            throw new Error("Kullanıcı profili bulunamadı.");
        }

        const profile = profileSnapshot.data();
        currentUsername = profile.username || "";
        currentNickname = profile.nickname || currentUsername;
        currentAvatarId = AVATARS[profile.avatarId] ? profile.avatarId : DEFAULT_AVATAR_ID;
        pendingAvatarId = currentAvatarId;

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
    renderAvatarPicker();

    const status = $("avatarSaveMessage");
    if (pendingAvatarId === currentAvatarId) {
        status.textContent = "Kayıtlı avatarın seçili.";
        status.className = "avatar-save-status";
    } else {
        status.textContent = "Seçimin hazır. Değişikliği uygulamak için Avatarı kaydet'e bas.";
        status.className = "avatar-save-status";
    }
});


// SAVE PROFILE AVATAR

function publishAvatarChange(avatarId) {
    document.dispatchEvent(
        new CustomEvent("caca:avatar-changed", {
            detail: { avatarId }
        })
    );
}

$("saveAvatarButton").addEventListener("click", async () => {
    if (accountActionInProgress || pendingAvatarId === currentAvatarId) return;

    const user = auth.currentUser;
    if (!user) {
        const status = $("avatarSaveMessage");
        status.textContent = "Oturum bulunamadı. Tekrar giriş yap.";
        status.className = "avatar-save-status error";
        return;
    }

    const previousAvatarId = currentAvatarId;
    const nextAvatarId = pendingAvatarId;

    if (!AVATARS[nextAvatarId]) return;

    accountActionInProgress = true;
    renderAvatarPicker();

    const status = $("avatarSaveMessage");
    status.textContent = "Avatar kaydediliyor...";
    status.className = "avatar-save-status saving";

    // Show the new avatar immediately. Roll it back if Firestore rejects
    // the update, so the interface never silently displays an unsaved choice.
    currentAvatarId = nextAvatarId;
    publishAvatarChange(nextAvatarId);

    try {
        await updateDoc(doc(db, "users", user.uid), {
            avatarId: nextAvatarId
        });

        status.textContent = `${AVATARS[nextAvatarId].label} avatarın kaydedildi.`;
        status.className = "avatar-save-status success";
        showSettingsMessage("Profil avatarın güncellendi.", true);
    } catch (error) {
        console.error("CACA avatar save failed:", error);

        currentAvatarId = previousAvatarId;
        pendingAvatarId = previousAvatarId;
        renderAvatarPicker();
        publishAvatarChange(previousAvatarId);

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
        $("userAvatar").textContent = nickname.charAt(0).toUpperCase();
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

    const [membersSnapshot, bansSnapshot, messagesSnapshot] = await Promise.all([
        getDocs(collection(db, "rooms", roomId, "members")),
        getDocs(collection(db, "rooms", roomId, "bans")),
        getDocs(collection(db, "rooms", roomId, "messages"))
    ]);

    const referencesToDelete = [];

    membersSnapshot.forEach((memberSnapshot) => {
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
