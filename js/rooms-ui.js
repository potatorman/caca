import { auth, db } from "./firebase.js";
import { AVATARS, DEFAULT_AVATAR_ID, setAvatarElement } from "./avatars.js";
import { EMOJI_DATA } from "./emoji-data.js";
import { GAME_REGISTRY, getGameDefinition } from "../games/registry.js";
import {
    reconcileMatchPlayers as reconcileUnoMatchPlayers,
    forfeitMatch as forfeitUnoMatch,
    returnToLobby as returnUnoToLobby
} from "../games/uno/index.js";
import {
    reconcileMatchPlayers as reconcileVampirKoyluMatchPlayers,
    forfeitMatch as forfeitVampirKoyluMatch,
    returnToLobby as returnVampirKoyluToLobby
} from "../games/vampir-koylu/index.js";

import {
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";

import {
    addDoc,
    Timestamp,
    collection,
    doc,
    getDoc,
    getDocs,
    onSnapshot,
    query,
    orderBy,
    limit,
    writeBatch,
    deleteDoc,
    updateDoc,
    setDoc,
    serverTimestamp,
    arrayUnion,
    arrayRemove,
    runTransaction
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

function filterMemberList() {
    const list = $("membersList");
    const search = $("membersSearch");
    if (!list || !search) return;

    const term = search.value.trim().toLocaleLowerCase("tr");
    let visibleCount = 0;

    list.querySelectorAll(".member-item").forEach((item) => {
        const matches = !term || item.textContent.toLocaleLowerCase("tr").includes(term);
        item.hidden = !matches;
        if (matches) visibleCount++;
    });

    list.querySelectorAll(".member-group").forEach((group) => {
        const hasVisible = Array.from(group.querySelectorAll(".member-item"))
            .some(item => !item.hidden);
        group.hidden = !hasVisible;
    });

    let empty = list.querySelector(".member-search-empty");
    if (term && visibleCount === 0) {
        if (!empty) {
            empty = document.createElement("p");
            empty.className = "member-search-empty";
            empty.textContent = "Bu aramayla eşleşen üye yok.";
            list.appendChild(empty);
        }
    } else if (empty) {
        empty.remove();
    }
}

$("membersSearch")?.addEventListener("input", filterMemberList);

document.addEventListener("keydown", (event) => {
    if (
        event.key !== "/" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof Element &&
            event.target.closest("input, textarea, select, button, [contenteditable='true']"))
    ) {
        return;
    }

    const roomView = $("roomView");
    const roomLayout = $("roomChatLayout");
    if (
        !roomView ||
        roomView.hidden ||
        !roomLayout ||
        roomLayout.classList.contains("members-collapsed")
    ) {
        return;
    }

    event.preventDefault();
    $("membersSearch").focus();
});

// USER STATE

let currentUser = null;
let currentUsername = "";
let currentAvatarId = DEFAULT_AVATAR_ID;
let currentAvatarData = null;
let activeRoomCode = "";
let activeRoomId = null;
let openingRoomId = null;
let roomOpenRequestVersion = 0;

// Realtime listener for room members
let unsubscribeMembers = null;
let unsubscribeMyMembership = null;
let unsubscribeBanned = null;
let unsubscribeMessages = null;
let unsubscribePranks = null;
let unsubscribePersonalPranks = null;
let unsubscribeGameSession = null;
let gameSessionData = null;
let activeRoomGame = null;
let observedUnoRosterRoundKey = "";
let observedUnoRosterIds = [];
let observedVampirRosterRoundKey = "";
let observedVampirRosterIds = [];
let activeRoomGameKey = "";
let openingRoomGameKey = "";
let roomGameOpenGeneration = 0;
let gameSessionResultsTimer = null;
let gameSessionResultsTimerKey = "";
let selectedGameId = GAME_REGISTRY.find((game) => game.lobbyEnabled !== false)?.id || "";
let gameSessionStartInProgress = false;
let gameSessionCountdownTimer = null;
let gameSessionCountdownEndAt = null;
let gameLobbyCooldownTimer = null;
let activeRoomOwnerId = null;
let currentRoomMemberRecord = null;
let currentAdminExpiryTimer = null;
let ownerAdminExpiryTimer = null;
const expiredAdminCleanupInProgress = new Set();
let memberRenderVersion = 0;
let bannedRenderVersion = 0;
let isDeletingRoom = false;
let messageRenderVersion = 0;
const publicProfileCache = new Map();
const liveProfileUnsubscribers = new Map();
let activeRoomMembers = [];
let currentJumpscareSlots = { slot1: null, slot2: null, slot3: null };
let pendingJumpscareCrop = null;
let jumpscareLibraryLoadedFor = null;
let jumpscareLibraryLoadPromise = null;
let selectedJumpscareSlot = "slot1";
let lastPersonalPrankSentAt = 0;
let lastSeenPersonalPrankEventId = null;
let lastSeenPrankEventId = null;
let lastPrankDispatchAt = 0;
let prankOverlayTimer = null;
let prankShakeTimer = null;

// ROOM CODE

const roomChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateRoomCode() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);

    return Array.from(
        bytes,
        byte => roomChars[byte % roomChars.length]
    ).join("");
}

// MESSAGES

function showRoomMessage(message, success = false) {
    const element = $("roomMessage");

    element.textContent = message;
    element.className = "status-message";

    if (success) {
        element.classList.add("success");
    }
}

function showModerationNotice(title, message, kind = "info") {
    const dialog = $("moderationNoticeDialog");
    if (!dialog) {
        showRoomMessage(message, kind === "success");
        return;
    }

    const card = dialog.querySelector(".moderation-notice-card");
    const symbol = $("moderationNoticeSymbol");

    $("moderationNoticeTitle").textContent = title;
    $("moderationNoticeBody").textContent = message;
    card.dataset.kind = kind;
    symbol.textContent =
        kind === "success" ? "✓" :
        kind === "ban" ? "⊘" :
        kind === "kick" ? "−" : "!";

    if (!dialog.open) {
        dialog.showModal();
    }
}

$("moderationNoticeClose")?.addEventListener("click", () => {
    $("moderationNoticeDialog")?.close();
});

$("moderationNoticeDialog")?.addEventListener("click", (event) => {
    if (event.target === $("moderationNoticeDialog")) {
        $("moderationNoticeDialog").close();
    }
});

function showError(error) {
    console.error("CACA error:", error);

    if (error.code === "permission-denied") {
        return "Firebase izin vermedi. Firestore Rules ayarlarını kontrol et.";
    }

    if (error.code === "unavailable") {
        return "İnternet bağlantısını kontrol et.";
    }

    return error.message || "Bir hata oluştu.";
}

// STOP LIVE PROFILE LISTENERS

function stopLiveProfileListeners() {
    for (const unsubscribe of liveProfileUnsubscribers.values()) {
        unsubscribe();
    }

    liveProfileUnsubscribers.clear();
}

// STOP MEMBER LISTENER

function stopMemberListener() {
    // Invalidate any room-opening reads that are still in flight.
    roomOpenRequestVersion += 1;
    openingRoomId = null;

    if (unsubscribeMembers) {
        unsubscribeMembers();
        unsubscribeMembers = null;
    }

    if (unsubscribeMyMembership) {
        unsubscribeMyMembership();
        unsubscribeMyMembership = null;
    }

    if (unsubscribeBanned) {
        unsubscribeBanned();
        unsubscribeBanned = null;
    }

    if (unsubscribeMessages) {
        unsubscribeMessages();
        unsubscribeMessages = null;
    }

    if (unsubscribePranks) {
        unsubscribePranks();
        unsubscribePranks = null;
    }
    if (unsubscribePersonalPranks) {
        unsubscribePersonalPranks();
        unsubscribePersonalPranks = null;
    }
    if (unsubscribeGameSession) {
        unsubscribeGameSession();
        unsubscribeGameSession = null;
    }
    gameSessionData = null;
    activeRoomGame?.close();
    activeRoomGame = null;
    activeRoomGameKey = "";
    gameSessionStartInProgress = false;
    clearGameSessionCountdown();
    gameSpectatorJoinInProgress = false;

    clearCurrentAdminExpiryTimer();
    clearOwnerAdminExpiryTimer();

    if (prankOverlayTimer) {
        clearTimeout(prankOverlayTimer);
        prankOverlayTimer = null;
    }
    if (prankShakeTimer) {
        clearTimeout(prankShakeTimer);
        prankShakeTimer = null;
    }
    $("roomPrankOverlay")?.setAttribute("hidden", "");
    $("roomPrankOverlay")?.classList.remove("is-active");
    document.body.classList.remove("room-screen-shake");

    stopLiveProfileListeners();

    messageRenderVersion += 1;
    activeRoomId = null;
    activeRoomOwnerId = null;
    currentRoomMemberRecord = null;
    activeRoomMembers = [];
    if ($("roomManagementPanel")) $("roomManagementPanel").hidden = true;
    if ($("adminPanel")) $("adminPanel").hidden = true;
    if (pendingJumpscareCrop) closeJumpscareCrop();
    if ($("jumpscarePanel")) $("jumpscarePanel").hidden = true;
    if ($("jumpscareOpenButton")) $("jumpscareOpenButton").hidden = true;
    if ($("gameCenterPanel")) $("gameCenterPanel").hidden = true;
}

// Resolve the current public profile so older membership/ban records
// still show the account username separately from the current nickname.
async function getPublicProfile(userId) {
    if (!userId) return null;

    if (!publicProfileCache.has(userId)) {
        const profileRequest = getDoc(doc(db, "users", userId))
            .then((snapshot) => snapshot.exists() ? snapshot.data() : null)
            .catch((error) => {
                console.warn("CACA: Could not load public profile:", userId, error);
                return null;
            });

        publicProfileCache.set(userId, profileRequest);
    }

    return publicProfileCache.get(userId);
}

async function getAccountDisplayNames(userId, fallbackName = "Bilinmeyen kullanıcı") {
    const profile = await getPublicProfile(userId);

    if (profile) {
        const accountUsername = profile.username || fallbackName;

        return {
            accountUsername,
            displayNickname: profile.nickname || accountUsername,
            avatarId: AVATARS[profile.avatarId] ? profile.avatarId : DEFAULT_AVATAR_ID,
            avatarData: profile.avatarData || null
        };
    }

    return {
        accountUsername: fallbackName,
        displayNickname: fallbackName,
        avatarId: DEFAULT_AVATAR_ID,
        avatarData: null
    };
}

// Apply a live profile update to every visible representation of that user.
// This keeps the member list, banned list and already-rendered chat messages
// synchronized without restarting the room or requiring a page refresh.
function updateLiveProfileUI(userId, profile) {
    const accountUsername = profile?.username || "Bilinmeyen kullanıcı";
    const displayNickname = profile?.nickname || accountUsername;
    const avatarId = AVATARS[profile?.avatarId]
        ? profile.avatarId
        : DEFAULT_AVATAR_ID;
    const avatarData = profile?.avatarData || null;

    for (const list of [$("membersList"), $("bannedList"), $("roomAdminsList")]) {
        if (!list) continue;

        const item = Array.from(
            list.querySelectorAll("[data-user-id]")
        ).find((element) => element.dataset.userId === userId);

        if (!item) continue;

        const avatar = item.querySelector(".member-avatar");
        if (avatar) setAvatarElement(avatar, avatarId, avatarData);

        const nickname = item.querySelector(".member-display-name, .room-admin-info strong");
        if (nickname) nickname.textContent = displayNickname;

        const username = item.querySelector(".member-account-username");
        if (username) {
            const usernameDiffers =
                accountUsername.trim().toLowerCase() !==
                displayNickname.trim().toLowerCase();

            username.textContent = usernameDiffers
                ? `(${accountUsername})`
                : "";
            username.hidden = !usernameDiffers;
        }
    }

    filterMemberList();

    const messagesList = $("chatMessages");
    if (!messagesList) return;

    for (const row of messagesList.querySelectorAll(".message-row")) {
        if (row.dataset.senderId !== userId) continue;

        const avatar = row.querySelector(".message-avatar");
        if (avatar) setAvatarElement(avatar, avatarId, avatarData);

        const author = row.querySelector(".message-meta strong");
        if (author) author.textContent = displayNickname;
    }
}

// LOAD MY ROOMS

async function loadRooms() {
    if (!currentUser) return;

    const roomsList = $("roomsList");
    roomsList.replaceChildren();

    try {
        const snapshot = await getDocs(
            collection(db, "users", currentUser.uid, "rooms")
        );

        $("roomCount").textContent = `${snapshot.size} oda`;

        if (snapshot.empty) {
            const empty = document.createElement("p");
            empty.className = "empty-rooms";
            empty.textContent = "Henüz bir odan yok. İlk odanı oluştur!";

            roomsList.appendChild(empty);
            return;
        }

        snapshot.forEach((roomDoc) => {
            const room = roomDoc.data();

            const button = document.createElement("button");
            button.type = "button";
            button.className = "room-list-item";
            button.dataset.roomId = roomDoc.id;
            button.classList.toggle("active", roomDoc.id === activeRoomId);

            const info = document.createElement("div");

            const name = document.createElement("strong");
            name.textContent = room.name;

            const role = document.createElement("span");
            role.textContent =
                room.role === "owner" ? "Oda sahibi" : "Üye";

            info.append(name, role);

            const arrow = document.createElement("span");
            arrow.textContent = "→";

            button.append(info, arrow);

            button.addEventListener("click", () => {
                openRoom(roomDoc.id);
            });

            roomsList.appendChild(button);
        });

    } catch (error) {
        showRoomMessage(showError(error));
    }
}


// MESSAGE ACTIONS: inline editing and contextual menus

function closeMessageMenus(exceptMenu = null) {
    document.querySelectorAll(".message-action-menu").forEach((menu) => {
        if (menu !== exceptMenu) menu.hidden = true;
    });

    document.querySelectorAll(".message-more-button").forEach((button) => {
        const menu = button.parentElement?.querySelector(".message-action-menu");
        if (menu !== exceptMenu) button.setAttribute("aria-expanded", "false");
    });
}

document.addEventListener("click", (event) => {
    if (!event.target.closest(".message-actions")) closeMessageMenus();
});

function startMessageEdit(messageId, originalText, bubble) {
    const editor = document.createElement("form");
    editor.className = "message-edit-form";

    const textarea = document.createElement("textarea");
    textarea.value = originalText;
    textarea.maxLength = 2000;
    textarea.rows = Math.max(2, Math.min(6, originalText.split("\n").length));
    textarea.setAttribute("aria-label", "Mesajı düzenle");

    const footer = document.createElement("div");
    footer.className = "message-edit-footer";
    const hint = document.createElement("span");
    hint.textContent = "Esc ile iptal edebilirsin.";
    const buttons = document.createElement("div");
    buttons.className = "message-edit-buttons";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "message-edit-cancel";
    cancelButton.textContent = "İptal";
    cancelButton.addEventListener("click", () => editor.replaceWith(bubble));

    const saveButton = document.createElement("button");
    saveButton.type = "submit";
    saveButton.className = "message-edit-save";
    saveButton.textContent = "Kaydet";

    buttons.append(cancelButton, saveButton);
    footer.append(hint, buttons);
    editor.append(textarea, footer);

    textarea.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            editor.replaceWith(bubble);
        }
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            editor.requestSubmit();
        }
    });

    editor.addEventListener("submit", async (event) => {
        event.preventDefault();
        const nextText = textarea.value.trim();

        if (!nextText) {
            showChatStatus("Mesaj boş olamaz.");
            textarea.focus();
            return;
        }
        if (nextText.length > 2000) {
            showChatStatus("Mesaj en fazla 2.000 karakter olabilir.");
            return;
        }
        if (nextText === originalText) {
            editor.replaceWith(bubble);
            return;
        }

        saveButton.disabled = true;
        cancelButton.disabled = true;
        try {
            await updateDoc(
                doc(db, "rooms", activeRoomId, "messages", messageId),
                { text: nextText, editedAt: serverTimestamp() }
            );
            showChatStatus("Mesaj güncellendi.", true);
        } catch (error) {
            console.error("CACA message edit failed:", error);
            showChatStatus(
                error.code === "permission-denied"
                    ? "Mesaj düzenleme izni yok. Firestore Rules içindeki mesaj update iznini kontrol et."
                    : "Mesaj düzenlenemedi: " + (error.message || "Bilinmeyen hata")
            );
            saveButton.disabled = false;
            cancelButton.disabled = false;
        }
    });

    bubble.replaceWith(editor);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

async function deleteChatMessage(messageId) {
    if (!currentUser || !activeRoomId) return;
    if (!window.confirm("Bu mesajı kalıcı olarak silmek istiyor musun?")) return;

    try {
        await deleteDoc(doc(db, "rooms", activeRoomId, "messages", messageId));
        showChatStatus("Mesaj silindi.", true);
    } catch (error) {
        console.error("CACA message delete failed:", error);
        showChatStatus(
            error.code === "permission-denied"
                ? "Mesaj silme izni yok. Firestore Rules içindeki mesaj delete iznini kontrol et."
                : "Mesaj silinemedi: " + (error.message || "Bilinmeyen hata")
        );
    }
}

// Owner-only room management panel.
function setRoomManagementOpen(isOpen) {
    const panel = $("roomManagementPanel");
    if (!panel || (isOpen && activeRoomOwnerId !== currentUser?.uid)) return;
    panel.hidden = !isOpen;

    if (isOpen) {
        $("roomManagementStatus").textContent = "";
        $("adminManagementStatus").textContent = "";
        $("adminTargetSelect")?.focus();
    } else {
        $("roomManagementButton")?.focus();
    }
}

// Admin panel: the room owner and active room admins can use management tools.
function setAdminPanelOpen(isOpen) {
    const panel = $("adminPanel");
    if (!panel || (isOpen && !canCurrentUserKickMembers())) return;
    panel.hidden = !isOpen;

    if (isOpen) {
        $("trollManagementStatus").textContent = "";
        $("shakeButton")?.focus();
    } else {
        $("adminPanelButton")?.focus();
    }
}

$("roomManagementButton").addEventListener("click", () => setRoomManagementOpen(true));
$("closeRoomManagementButton").addEventListener("click", () => setRoomManagementOpen(false));
$("roomManagementPanel").addEventListener("click", (event) => {
    if (event.target === $("roomManagementPanel")) setRoomManagementOpen(false);
});
$("adminPanelButton").addEventListener("click", () => setAdminPanelOpen(true));
$("closeAdminPanelButton").addEventListener("click", () => setAdminPanelOpen(false));
$("adminPanel").addEventListener("click", (event) => {
    if (event.target === $("adminPanel")) setAdminPanelOpen(false);
});
// Personal jumpscare is available from the Admin Panel only.
function setJumpscarePanelOpen(isOpen) {
    const panel = $("jumpscarePanel");
    if (!panel || (isOpen && (!currentUser || !activeRoomId || !canCurrentUserKickMembers()))) return;
    panel.hidden = !isOpen;
    if (isOpen) {
        $("personalJumpscareStatus").textContent = "";
        renderJumpscareTargets();
        $("jumpscareTargetSelect").focus();
        loadJumpscareLibrary();
    } else {
        if (!$("jumpscareCropDialog").hidden) closeJumpscareCrop();
        $("jumpscareOpenButton")?.focus();
    }
}

$("jumpscareOpenButton").addEventListener("click", () => setJumpscarePanelOpen(true));
$("closeJumpscarePanelButton").addEventListener("click", () => setJumpscarePanelOpen(false));
$("jumpscarePanel").addEventListener("click", (event) => {
    if (event.target === $("jumpscarePanel")) setJumpscarePanelOpen(false);
});

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("jumpscareCropDialog").hidden) {
        event.preventDefault();
        closeJumpscareCrop();
        return;
    }
    if (!$("roomManagementPanel").hidden) setRoomManagementOpen(false);
    if (!$("adminPanel").hidden) setAdminPanelOpen(false);
    if (!$("jumpscarePanel").hidden) setJumpscarePanelOpen(false);
    if (!$("gameCenterPanel").hidden) setGameCenterOpen(false);
});

async function clearRoomChatHistory() {
    if (!currentUser || !activeRoomId || activeRoomOwnerId !== currentUser.uid) return;

    const roomId = activeRoomId;
    const roomName = $("activeRoomName").textContent || "Bu oda";
    if (!window.confirm(
        `"${roomName}" odasındaki tüm mesajları kalıcı olarak silmek istiyor musun?\n\nOda, üyeler ve davet kodu silinmez. Bu işlem geri alınamaz.`
    )) return;

    const button = $("clearChatHistoryButton");
    button.disabled = true;
    button.textContent = "Sohbet siliniyor...";
    $("roomManagementStatus").textContent = "Mesajlar siliniyor...";
    let deletedCount = 0;

    try {
        while (activeRoomId === roomId) {
            const oldestMessages = await getDocs(
                query(
                    collection(db, "rooms", roomId, "messages"),
                    orderBy("createdAt", "asc"),
                    limit(10)
                )
            );
            if (oldestMessages.empty) break;

            const batch = writeBatch(db);
            oldestMessages.docs.forEach((messageDoc) => batch.delete(messageDoc.ref));
            await batch.commit();
            deletedCount += oldestMessages.size;
            $("roomManagementStatus").textContent = `${deletedCount} mesaj silindi...`;
        }

        if (activeRoomId === roomId) {
            $("roomManagementStatus").textContent = deletedCount
                ? `Sohbet geçmişi temizlendi. ${deletedCount} mesaj silindi.`
                : "Sohbet zaten boş.";
            showChatStatus(
                deletedCount ? "Oda sohbetinin tamamı temizlendi." : "Sohbet zaten boş.",
                true
            );
        }
    } catch (error) {
        console.error("CACA chat history clear failed:", error);
        $("roomManagementStatus").textContent =
            error.code === "permission-denied"
                ? "Mesajları silme izni yok. Firestore Rules içindeki mesaj delete iznini kontrol et."
                : "Sohbet temizlenemedi: " + (error.message || "Bilinmeyen hata");
    } finally {
        button.disabled = false;
        button.textContent = "Tüm sohbeti sil";
    }
}
$("clearChatHistoryButton").addEventListener("click", clearRoomChatHistory);

// REAL-TIME ROOM CHAT

function showChatStatus(message, success = false) {
    const element = $("chatStatus");
    if (!element) return;

    element.textContent = message;
    element.className = "chat-status";

    if (success) {
        element.classList.add("success");
    }
}

function formatMessageTime(timestamp) {
    if (!timestamp || typeof timestamp.toDate !== "function") {
        return "Şimdi";
    }

    return new Intl.DateTimeFormat("tr-TR", {
        hour: "2-digit",
        minute: "2-digit"
    }).format(timestamp.toDate());
}

function listenToMessages(roomId) {
    if (unsubscribeMessages) {
        unsubscribeMessages();
        unsubscribeMessages = null;
    }

    const messagesList = $("chatMessages");
    messagesList.replaceChildren();
    showChatStatus("");

    const messagesQuery = query(
        collection(db, "rooms", roomId, "messages"),
        orderBy("createdAt", "desc"),
        limit(100)
    );

    let firstSnapshot = true;

    unsubscribeMessages = onSnapshot(
        messagesQuery,
        async (snapshot) => {
            if (activeRoomId !== roomId) return;

            const renderVersion = ++messageRenderVersion;
            const wasNearBottom =
                firstSnapshot ||
                messagesList.scrollHeight -
                    messagesList.scrollTop -
                    messagesList.clientHeight < 140;

            if (snapshot.empty) {
                messagesList.replaceChildren();

                const empty = document.createElement("div");
                empty.className = "chat-empty-state";

                const icon = document.createElement("div");
                icon.className = "chat-empty-icon";
                icon.textContent = "✦";

                const title = document.createElement("strong");
                title.textContent = "İlk mesajı sen gönder";

                const hint = document.createElement("span");
                hint.textContent = "Bu odadaki sohbet burada başlayacak.";

                empty.append(icon, title, hint);
                messagesList.appendChild(empty);
                firstSnapshot = false;
                return;
            }

            // The query fetches the newest 100 messages in descending order.
            // Reverse them so the chat reads from top to bottom.
            const orderedMessages = [...snapshot.docs].reverse();

            // Load each sender profile once per snapshot. This also makes old
            // messages use the sender's current nickname and selected avatar.
            const senderIds = [
                ...new Set(
                    orderedMessages
                        .map((messageDoc) => messageDoc.data().senderId)
                        .filter(Boolean)
                )
            ];

            const senderProfiles = new Map(
                await Promise.all(
                    senderIds.map(async (senderId) => [
                        senderId,
                        await getPublicProfile(senderId)
                    ])
                )
            );

            // Ignore stale asynchronous profile reads after room changes
            // or a newer message snapshot.
            if (activeRoomId !== roomId || renderVersion !== messageRenderVersion) {
                return;
            }

            messagesList.replaceChildren();

            let previousMessage = null;

            for (const messageDoc of orderedMessages) {
                const message = messageDoc.data();
                const profile = senderProfiles.get(message.senderId);
                const senderName =
                    (profile?.nickname || profile?.username ||
                     (typeof message.senderName === "string" ? message.senderName.trim() : "")) ||
                    "Kullanıcı";
                const text =
                    typeof message.text === "string" ? message.text : "";

                if (!text) continue;

                const isMine = message.senderId === currentUser?.uid;
                // Prefer the current profile avatar so old messages update
                // immediately when their sender changes their avatar.
                const avatarId = AVATARS[profile?.avatarId]
                    ? profile.avatarId
                    : (AVATARS[message.senderAvatarId]
                        ? message.senderAvatarId
                        : DEFAULT_AVATAR_ID);

                const timestamp = message.createdAt?.toMillis
                    ? message.createdAt.toMillis()
                    : null;

                const isGrouped = Boolean(
                    previousMessage &&
                    previousMessage.senderId === message.senderId &&
                    timestamp !== null &&
                    previousMessage.timestamp !== null &&
                    timestamp >= previousMessage.timestamp &&
                    timestamp - previousMessage.timestamp <= 5 * 60 * 1000
                );

                const row = document.createElement("div");
                row.dataset.messageId = messageDoc.id;
                row.dataset.senderId = message.senderId || "";
                row.className = "message-row" +
                    (isMine ? " mine" : "") +
                    (isGrouped ? " grouped" : "");

                const avatar = document.createElement("div");
                avatar.className = "message-avatar";
                setAvatarElement(avatar, avatarId, profile?.avatarData || null);

                const content = document.createElement("div");
                content.className = "message-content";

                if (!isGrouped) {
                    const meta = document.createElement("div");
                    meta.className = "message-meta";
                    const author = document.createElement("strong");
                    author.textContent = senderName;
                    const time = document.createElement("time");
                    time.textContent = formatMessageTime(message.createdAt);
                    if (message.createdAt?.toDate) {
                        time.dateTime = message.createdAt.toDate().toISOString();
                    }
                    meta.append(author, time);
                    content.appendChild(meta);
                }

                const bubble = document.createElement("div");
                bubble.className = "message-bubble";
                bubble.textContent = text;
                content.appendChild(bubble);

                if (message.editedAt) {
                    const editedLabel = document.createElement("span");
                    editedLabel.className = "message-edited-label";
                    editedLabel.textContent = "düzenlendi";
                    content.appendChild(editedLabel);
                }

                const canDelete = isMine || activeRoomOwnerId === currentUser?.uid;
                if (canDelete) {
                    const actions = document.createElement("div");
                    actions.className = "message-actions";
                    const moreButton = document.createElement("button");
                    moreButton.type = "button";
                    moreButton.className = "message-more-button";
                    moreButton.textContent = "⋯";
                    moreButton.setAttribute("aria-label", "Mesaj seçenekleri");
                    moreButton.setAttribute("aria-expanded", "false");

                    const menu = document.createElement("div");
                    menu.className = "message-action-menu";
                    menu.hidden = true;

                    if (isMine) {
                        const editButton = document.createElement("button");
                        editButton.type = "button";
                        editButton.textContent = "Düzenle";
                        editButton.addEventListener("click", () => {
                            closeMessageMenus();
                            startMessageEdit(messageDoc.id, text, bubble);
                        });
                        menu.appendChild(editButton);
                    }

                    const deleteButton = document.createElement("button");
                    deleteButton.type = "button";
                    deleteButton.className = "delete";
                    deleteButton.textContent = "Mesajı sil";
                    deleteButton.addEventListener("click", () => {
                        closeMessageMenus();
                        deleteChatMessage(messageDoc.id);
                    });
                    menu.appendChild(deleteButton);

                    moreButton.addEventListener("click", (event) => {
                        event.stopPropagation();
                        const shouldOpen = menu.hidden;
                        closeMessageMenus(menu);
                        menu.hidden = !shouldOpen;
                        moreButton.setAttribute("aria-expanded", String(shouldOpen));
                    });
                    actions.append(moreButton, menu);
                    content.appendChild(actions);
                }

                row.append(avatar, content);
                messagesList.appendChild(row);

                previousMessage = {
                    senderId: message.senderId,
                    timestamp
                };
            }

            if (wasNearBottom) {
                requestAnimationFrame(() => {
                    messagesList.scrollTop = messagesList.scrollHeight;
                });
            }

            firstSnapshot = false;
        },
        (error) => {
            console.error("CACA chat listener failed:", error);
            showChatStatus(
                error.code === "permission-denied"
                    ? "Mesajları okuyamıyorum. Firestore Rules içinde oda mesajı okuma iznini kontrol et."
                    : "Mesajlar yüklenemedi: " + (error.message || "Bilinmeyen hata")
            );
        }
    );
}

// PERSONAL JUMPSCARE LIBRARY AND TARGETED DELIVERY

const JUMPSCARE_IMAGE_MAX_CHARS = 180000;
const JUMPSCARE_SLOT_FIELDS = ["slot1", "slot2", "slot3"];

function updateJumpscareSendButton() {
    const hasImage = Boolean(currentJumpscareSlots[selectedJumpscareSlot]);
    const hasTarget = Boolean($("jumpscareTargetSelect")?.value);
    $("sendPersonalJumpscareButton").disabled = !hasImage || !hasTarget;
}

function renderJumpscareSlots() {
    JUMPSCARE_SLOT_FIELDS.forEach((slot, index) => {
        const n = index + 1;
        const image = $(`jumpscareSlotPreview${n}`);
        const empty = $(`jumpscareSlotEmpty${n}`);
        const selectButton = $(`jumpscareSlotSelect${n}`);
        const clearButton = $(`jumpscareSlotClear${n}`);
        const data = currentJumpscareSlots[slot];

        image.src = data || "";
        image.hidden = !data;
        empty.hidden = Boolean(data);
        selectButton.classList.toggle("selected", selectedJumpscareSlot === slot);
        selectButton.setAttribute("aria-pressed", String(selectedJumpscareSlot === slot));
        clearButton.disabled = !data;
    });
    updateJumpscareSendButton();
}

function renderJumpscareTargets() {
    const select = $("jumpscareTargetSelect");
    if (!select) return;

    const previousTarget = select.value;
    select.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Gönderilecek üyeyi seç...";
    select.appendChild(placeholder);

    const canTargetAdmins =
        activeRoomOwnerId === currentUser?.uid || isCurrentUserRoomAdmin();

    const eligible = activeRoomMembers.filter((member) =>
        member.id !== currentUser?.uid &&
        member.id !== activeRoomOwnerId &&
        member.role !== "owner" &&
        (canTargetAdmins || !isActiveRoomAdmin(member))
    );
    eligible.forEach((member) => {
        const option = document.createElement("option");
        option.value = member.id;
        option.textContent = member.displayNickname || member.username || "Üye";
        select.appendChild(option);
    });

    if (eligible.some((member) => member.id === previousTarget)) select.value = previousTarget;
    if (!eligible.length) placeholder.textContent = "Hedef alınabilecek normal üye yok.";
    updateJumpscareSendButton();
}

$("jumpscareTargetSelect").addEventListener("change", updateJumpscareSendButton);

function selectJumpscareSlot(slot) {
    if (!JUMPSCARE_SLOT_FIELDS.includes(slot)) return;
    selectedJumpscareSlot = slot;
    renderJumpscareSlots();
}

const JUMPSCARE_CROP_WIDTH = 900;
const JUMPSCARE_CROP_HEIGHT = 506;

function getJumpscareCropDimensions(state) {
    const baseScale = Math.max(
        JUMPSCARE_CROP_WIDTH / state.bitmap.width,
        JUMPSCARE_CROP_HEIGHT / state.bitmap.height
    );
    const scale = baseScale * state.zoom;
    return {
        width: state.bitmap.width * scale,
        height: state.bitmap.height * scale
    };
}

function clampJumpscareCropPosition(state) {
    const size = getJumpscareCropDimensions(state);
    state.offsetX = Math.min(0, Math.max(JUMPSCARE_CROP_WIDTH - size.width, state.offsetX));
    state.offsetY = Math.min(0, Math.max(JUMPSCARE_CROP_HEIGHT - size.height, state.offsetY));
}

function drawJumpscareCrop() {
    const state = pendingJumpscareCrop;
    const canvas = $("jumpscareCropCanvas");
    if (!state || !canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const size = getJumpscareCropDimensions(state);
    clampJumpscareCropPosition(state);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#080910";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(state.bitmap, state.offsetX, state.offsetY, size.width, size.height);
}

async function openJumpscareCrop(file, slot, number) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
        throw new Error("Yalnızca PNG, JPG veya WebP görsel yükleyebilirsin.");
    }
    if (file.size > 12 * 1024 * 1024) {
        throw new Error("Dosya en fazla 12 MB olabilir.");
    }
    if (typeof createImageBitmap !== "function") {
        throw new Error("Tarayıcın görsel düzenlemeyi desteklemiyor. Güncel bir tarayıcı kullan.");
    }

    const userId = currentUser?.uid;
    if (!userId) throw new Error("Oturum bulunamadı.");
    await loadJumpscareLibrary();
    if (jumpscareLibraryLoadedFor !== userId) {
        throw new Error("Önce kayıtlı jumpscare görselleri yüklenmeli.");
    }

    const bitmap = await createImageBitmap(file);
    if (currentUser?.uid !== userId) {
        bitmap.close?.();
        return;
    }

    const baseScale = Math.max(
        JUMPSCARE_CROP_WIDTH / bitmap.width,
        JUMPSCARE_CROP_HEIGHT / bitmap.height
    );
    const width = bitmap.width * baseScale;
    const height = bitmap.height * baseScale;
    pendingJumpscareCrop = {
        bitmap,
        slot,
        number,
        userId,
        zoom: 1,
        offsetX: (JUMPSCARE_CROP_WIDTH - width) / 2,
        offsetY: (JUMPSCARE_CROP_HEIGHT - height) / 2,
        drag: null
    };

    $("jumpscareCropZoom").value = "1";
    $("jumpscareCropDialog").hidden = false;
    drawJumpscareCrop();
    $("cancelJumpscareCropButton").focus();
}

function closeJumpscareCrop() {
    if (pendingJumpscareCrop?.bitmap) {
        pendingJumpscareCrop.bitmap.close?.();
    }
    pendingJumpscareCrop = null;
    const dialog = $("jumpscareCropDialog");
    if (dialog) dialog.hidden = true;
    const canvas = $("jumpscareCropCanvas");
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
}

async function compressJumpscareCropCanvas(sourceCanvas) {
    for (const maxWidth of [900, 800, 700, 600, 520, 440, 360]) {
        const width = Math.min(maxWidth, sourceCanvas.width);
        const height = Math.max(1, Math.round(width * sourceCanvas.height / sourceCanvas.width));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Kadraj sıkıştırılamadı.");
        context.drawImage(sourceCanvas, 0, 0, width, height);

        for (const quality of [0.84, 0.76, 0.68, 0.60, 0.52]) {
            let dataUrl = canvas.toDataURL("image/webp", quality);
            if (!dataUrl.startsWith("data:image/webp;base64,")) {
                dataUrl = canvas.toDataURL("image/jpeg", quality);
            }
            if (
                dataUrl.length <= JUMPSCARE_IMAGE_MAX_CHARS &&
                /^data:image\/(webp|jpeg);base64,/.test(dataUrl)
            ) {
                return dataUrl;
            }
        }
    }
    throw new Error("Kadraj 180 KB sınırına sığmadı. Daha sade veya küçük bir görsel dene.");
}

async function saveJumpscareCrop() {
    const state = pendingJumpscareCrop;
    if (!state || !currentUser || currentUser.uid !== state.userId) return;
    const button = $("saveJumpscareCropButton");
    button.disabled = true;
    button.textContent = "Kaydediliyor...";
    $("jumpscareLibraryStatus").textContent = "Seçtiğin kadraj sıkıştırılıyor...";

    try {
        await loadJumpscareLibrary();
        if (currentUser?.uid !== state.userId || jumpscareLibraryLoadedFor !== state.userId) {
            throw new Error("Hesap değişti veya görsel kütüphanesi yüklenemedi.");
        }
        const dataUrl = await compressJumpscareCropCanvas($("jumpscareCropCanvas"));
        const next = { ...currentJumpscareSlots, [state.slot]: dataUrl };
        await setDoc(doc(db, "users", state.userId, "jumpscares", "library"), {
            ...next,
            updatedAt: serverTimestamp()
        });
        if (currentUser?.uid !== state.userId) return;

        currentJumpscareSlots = next;
        jumpscareLibraryLoadedFor = state.userId;
        selectedJumpscareSlot = state.slot;
        const number = state.number;
        closeJumpscareCrop();
        renderJumpscareSlots();
        $("jumpscareLibraryStatus").textContent =
            `Jumpscare ${number} kadrajı kaydedildi. Sadece senin hesabında saklanıyor.`;
    } catch (error) {
        console.error("CACA jumpscare crop save failed:", error);
        $("jumpscareLibraryStatus").textContent = error.message || "Kadraj kaydedilemedi.";
    } finally {
        button.disabled = false;
        button.textContent = "Kadrajı kaydet";
    }
}

const jumpscareCropCanvas = $("jumpscareCropCanvas");
jumpscareCropCanvas.addEventListener("pointerdown", (event) => {
    if (!pendingJumpscareCrop) return;
    const state = pendingJumpscareCrop;
    state.drag = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        offsetX: state.offsetX,
        offsetY: state.offsetY
    };
    jumpscareCropCanvas.setPointerCapture(event.pointerId);
});
jumpscareCropCanvas.addEventListener("pointermove", (event) => {
    const state = pendingJumpscareCrop;
    if (!state?.drag || state.drag.pointerId !== event.pointerId) return;
    const rect = jumpscareCropCanvas.getBoundingClientRect();
    state.offsetX = state.drag.offsetX +
        (event.clientX - state.drag.clientX) * jumpscareCropCanvas.width / rect.width;
    state.offsetY = state.drag.offsetY +
        (event.clientY - state.drag.clientY) * jumpscareCropCanvas.height / rect.height;
    drawJumpscareCrop();
});
["pointerup", "pointercancel", "lostpointercapture"].forEach((eventName) => {
    jumpscareCropCanvas.addEventListener(eventName, () => {
        if (pendingJumpscareCrop) pendingJumpscareCrop.drag = null;
    });
});

$("jumpscareCropZoom").addEventListener("input", (event) => {
    const state = pendingJumpscareCrop;
    if (!state) return;
    const oldSize = getJumpscareCropDimensions(state);
    const centerRatioX = (JUMPSCARE_CROP_WIDTH / 2 - state.offsetX) / oldSize.width;
    const centerRatioY = (JUMPSCARE_CROP_HEIGHT / 2 - state.offsetY) / oldSize.height;
    state.zoom = Math.min(3, Math.max(1, Number(event.target.value) || 1));
    const newSize = getJumpscareCropDimensions(state);
    state.offsetX = JUMPSCARE_CROP_WIDTH / 2 - centerRatioX * newSize.width;
    state.offsetY = JUMPSCARE_CROP_HEIGHT / 2 - centerRatioY * newSize.height;
    drawJumpscareCrop();
});
$("cancelJumpscareCropButton").addEventListener("click", closeJumpscareCrop);
$("saveJumpscareCropButton").addEventListener("click", saveJumpscareCrop);

[1, 2, 3].forEach((n) => {
    const slot = `slot${n}`;
    $(`jumpscareSlotSelect${n}`).addEventListener("click", () => selectJumpscareSlot(slot));

    $(`jumpscareSlotFile${n}`).addEventListener("change", async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        $("jumpscareLibraryStatus").textContent = "Görsel düzenleyici açılıyor...";
        try {
            await openJumpscareCrop(file, slot, n);
        } catch (error) {
            console.error("CACA jumpscare crop open failed:", error);
            $("jumpscareLibraryStatus").textContent = error.message || "Görsel açılamadı.";
        } finally {
            event.target.value = "";
        }
    });

    $(`jumpscareSlotClear${n}`).addEventListener("click", async () => {
        if (!currentUser) return;
        const userId = currentUser.uid;
        const button = $(`jumpscareSlotClear${n}`);
        button.disabled = true;
        try {
            await loadJumpscareLibrary();
            if (jumpscareLibraryLoadedFor !== userId) {
                throw new Error("Kayıtlı görseller yüklenemedi.");
            }
            const next = { ...currentJumpscareSlots, [slot]: null };
            await setDoc(doc(db, "users", userId, "jumpscares", "library"), {
                ...next, updatedAt: serverTimestamp()
            });
            if (currentUser?.uid !== userId) return;
            currentJumpscareSlots = next;
            renderJumpscareSlots();
            $("jumpscareLibraryStatus").textContent = `Jumpscare ${n} silindi.`;
        } catch (error) {
            $("jumpscareLibraryStatus").textContent = error.message || "Görsel silinemedi.";
        } finally {
            button.disabled = !currentJumpscareSlots[slot];
        }
    });
});

async function loadJumpscareLibrary() {
    const userId = currentUser?.uid;
    if (!userId || jumpscareLibraryLoadedFor === userId) {
        renderJumpscareSlots();
        return;
    }
    if (jumpscareLibraryLoadPromise) return jumpscareLibraryLoadPromise;

    jumpscareLibraryLoadPromise = (async () => {
        $("jumpscareLibraryStatus").textContent = "Kayıtlı görseller yükleniyor...";
        try {
            const snapshot = await getDoc(doc(db, "users", userId, "jumpscares", "library"));
            if (currentUser?.uid !== userId) return;
            const data = snapshot.exists() ? snapshot.data() : {};
            currentJumpscareSlots = {
                slot1: typeof data.slot1 === "string" ? data.slot1 : null,
                slot2: typeof data.slot2 === "string" ? data.slot2 : null,
                slot3: typeof data.slot3 === "string" ? data.slot3 : null
            };
            jumpscareLibraryLoadedFor = userId;
            renderJumpscareSlots();
            $("jumpscareLibraryStatus").textContent = "Üç görsel alanın hazır.";
        } catch (error) {
            console.error("CACA jumpscare library read failed:", error);
            $("jumpscareLibraryStatus").textContent = error.code === "permission-denied"
                ? "Kişisel jumpscare kütüphanesi için Firestore Rules yayımlanmalı."
                : "Görseller yüklenemedi: " + (error.message || "Bilinmeyen hata");
        } finally {
            jumpscareLibraryLoadPromise = null;
        }
    })();
    return jumpscareLibraryLoadPromise;
}

async function sendPersonalJumpscare() {
    if (!currentUser || !activeRoomId || !canCurrentUserKickMembers()) return;
    const targetId = $("jumpscareTargetSelect").value;
    const target = activeRoomMembers.find((member) => member.id === targetId);
    const imageData = currentJumpscareSlots[selectedJumpscareSlot];

    if (!imageData) {
        $("personalJumpscareStatus").textContent = "Önce göndermek istediğin görseli yükle.";
        return;
    }
    const canTargetAdmins =
        activeRoomOwnerId === currentUser.uid || isCurrentUserRoomAdmin();

    if (!target || target.id === currentUser.uid || target.id === activeRoomOwnerId ||
        target.role === "owner" || (isActiveRoomAdmin(target) && !canTargetAdmins)) {
        $("personalJumpscareStatus").textContent = canTargetAdmins
            ? "Kendini veya oda sahibini hedef alamazsın."
            : "Oda sahibi ve aktif yöneticiler hedef alınamaz.";
        renderJumpscareTargets();
        return;
    }
    if (Date.now() - lastPersonalPrankSentAt < 6000) {
        $("personalJumpscareStatus").textContent = "Yeni bir jumpscare göndermeden önce birkaç saniye bekle.";
        return;
    }

    const requestedDurationMs = Number($("jumpscareDurationSelect")?.value);
    const durationMs = [3000, 5000, 10000, 15000].includes(requestedDurationMs)
        ? requestedDurationMs
        : 5000;

    const button = $("sendPersonalJumpscareButton");
    button.disabled = true;
    $("personalJumpscareStatus").textContent = "Gönderiliyor...";
    try {
        await setDoc(doc(db, "rooms", activeRoomId, "prankInbox", target.id), {
            eventId: crypto.randomUUID(),
            type: "custom-jumpscare",
            senderId: currentUser.uid,
            senderName: currentUsername || "Bir oda üyesi",
            imageData,
            durationMs,
            sentAt: serverTimestamp()
        });
        lastPersonalPrankSentAt = Date.now();
        $("personalJumpscareStatus").textContent =
            `Jumpscare ${target.displayNickname || target.username} kullanıcısına gönderildi.`;
    } catch (error) {
        console.error("CACA targeted jumpscare send failed:", error);
        $("personalJumpscareStatus").textContent = error.code === "permission-denied"
            ? "Gönderilemedi. Hedef odadan ayrılmış veya yönetici olmuş olabilir. Firestore Rules güncel olmalı."
            : "Gönderilemedi: " + (error.message || "Bilinmeyen hata");
    } finally {
        updateJumpscareSendButton();
    }
}

$("sendPersonalJumpscareButton").addEventListener("click", sendPersonalJumpscare);

// ROOM GAME CENTER — persistent lobby with independent match cycles.

function getGameSessionRef(roomId = activeRoomId) {
    return doc(db, "rooms", roomId, "gameSessions", "active");
}

// Player limits come from the game registry; unknown games use these defaults.
function getGameLimits(gameId, session = null) {
    const game = getGameDefinition(gameId);
    return {
        minPlayers: Number(game?.minPlayers) || 2,
        maxPlayers: Math.min(Number(game?.maxPlayers) || 20, Math.max(Number(game?.minPlayers) || 2, Number(session?.maxPlayers) || Number(game?.maxPlayers) || 20))
    };
}

function getVampirLobbySettings(session) {
    const settings = session?.gameSettings || {};
    const targetPlayerCount = Number(settings.targetPlayerCount);
    return {
        botFillEnabled: settings.botFillEnabled === true,
        targetPlayerCount: Number.isInteger(targetPlayerCount) &&
            targetPlayerCount >= 5 && targetPlayerCount <= 12
            ? targetPlayerCount
            : 5
    };
}

// Bots only exist inside the Durable Object. Firebase lobby and ready lists remain real-user-only.
function isLobbyReadyToStart(session) {
    const players = Array.isArray(session.playerIds) ? session.playerIds : [];
    const ready = Array.isArray(session.readyIds) ? session.readyIds : [];
    const { maxPlayers } = getGameLimits(session.gameId, session);
    if (session.gameId === "vampir-koylu") {
        const settings = getVampirLobbySettings(session);
        const minRealPlayers = settings.botFillEnabled ? 1 : 5;
        return players.length >= minRealPlayers &&
            (!settings.botFillEnabled || players.length <= settings.targetPlayerCount) &&
            players.length <= maxPlayers &&
            players.every((id) => ready.includes(id));
    }
    const { minPlayers } = getGameLimits(session.gameId, session);
    return players.length >= minPlayers &&
        players.length <= maxPlayers &&
        players.every((id) => ready.includes(id));
}

function setGameCenterStatus(message, isError = false) {
    const status = $("gameCenterStatus");
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("error", Boolean(isError));
}

function getGameLobbyCooldownUntil(roomId = activeRoomId) {
    if (!roomId) return 0;
    try {
        const key = "caca-game-lobby-cooldown:" + roomId;
        const stored = Number(localStorage.getItem(key));
        if (!Number.isFinite(stored) || stored <= Date.now()) {
            localStorage.removeItem(key);
            return 0;
        }
        return stored;
    } catch {
        return 0;
    }
}

function recordGameLobbyCooldown(roomId, sessionData) {
    if (!roomId || sessionData?.status !== "results") return;
    const finishedAt = sessionData.finishedAt?.toMillis?.();
    const until = (Number.isFinite(finishedAt) ? finishedAt : Date.now()) + 3000;
    try {
        localStorage.setItem("caca-game-lobby-cooldown:" + roomId, String(until));
    } catch {
        // The disabled button still provides a per-tab fallback when storage is unavailable.
    }
    if (gameLobbyCooldownTimer) clearInterval(gameLobbyCooldownTimer);
    gameLobbyCooldownTimer = setInterval(() => {
        renderGameCatalog();
        if (getGameLobbyCooldownUntil(roomId) <= Date.now()) {
            clearInterval(gameLobbyCooldownTimer);
            gameLobbyCooldownTimer = null;
        }
    }, 200);
}

function renderGameCatalog() {
    const grid = $("gameCatalogGrid");
    const createButton = $("createGameSessionButton");
    if (!grid || !createButton) return;
    const games = GAME_REGISTRY.filter((game) => game.lobbyEnabled !== false);
    if (!games.some((game) => game.id === selectedGameId)) selectedGameId = games[0]?.id || "";
    grid.replaceChildren();
    games.forEach((game) => {
        const selected = game.id === selectedGameId;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "game-catalog-card honeycomb-game-button";
        button.dataset.gameId = game.id;
        button.setAttribute("aria-pressed", String(selected));
        button.classList.toggle("is-selected", selected);
        const name = document.createElement("strong");
        name.className = "game-catalog-name";
        name.textContent = game.name;
        const range = document.createElement("span");
        range.className = "game-catalog-player-count";
        range.textContent = "Min. " + game.minPlayers + " · Maks. " + game.maxPlayers + " oyuncu";
        button.append(name, range);
        grid.appendChild(button);
    });

    // Temporary, non-interactive tiles make the intended three-row honeycomb
    // composition visible while the catalog still contains only two real games.
    const placeholders = [
        "Yakında yeni oyunlar",
        "Yakında yeni oyunlar",
        "Yakında yeni oyunlar",
        "Yakında yeni oyunlar",
        "Yakında yeni oyunlar"
    ];
    placeholders.forEach((label) => {
        const tile = document.createElement("div");
        tile.className = "game-catalog-placeholder-tile";
        tile.setAttribute("aria-hidden", "true");
        const name = document.createElement("strong");
        name.textContent = label;
        const detail = document.createElement("span");
        detail.textContent = "Oyun alanı";
        tile.append(name, detail);
        grid.appendChild(tile);
    });

    const selected = games.find((game) => game.id === selectedGameId);
    const maxSelect = $("gameMaxPlayersSelect");
    if (maxSelect && selected) {
        const previous = Number(maxSelect.value);
        maxSelect.replaceChildren();
        for (let count = selected.minPlayers; count <= selected.maxPlayers; count++) {
            const option = document.createElement("option");
            option.value = String(count);
            option.textContent = count + " oyuncu";
            maxSelect.appendChild(option);
        }
        maxSelect.value = String(Number.isInteger(previous) && previous >= selected.minPlayers && previous <= selected.maxPlayers ? previous : selected.maxPlayers);
    }
    const cooldown = Math.max(0, getGameLobbyCooldownUntil() - Date.now());
    createButton.disabled = !selected || cooldown > 0 || !activeRoomId;
    createButton.textContent = cooldown > 0
        ? "Yeni lobi için " + Math.ceil(cooldown / 1000) + " sn bekle"
        : !activeRoomId
            ? "Önce bir sohbet odasına gir"
            : selected ? selected.name + " lobisi oluştur" : "Lobi oluştur";
}

function renderOpenGameLobbies() {
    const list = $("openGameLobbiesList");
    const count = $("openGameLobbyCount");
    if (!list || !count) return;
    list.replaceChildren();
    if (!gameSessionData || !activeRoomId || gameSessionData.status === "results") {
        count.textContent = "0";
        const empty = document.createElement("p");
        empty.className = "open-lobbies-empty";
        empty.textContent = activeRoomId
            ? "Bu odada şu anda açık lobi yok."
            : "Açık lobileri görmek için önce bir sohbet odasına gir.";
        list.appendChild(empty);
        return;
    }
    const game = getGameDefinition(gameSessionData.gameId);
    const players = Array.isArray(gameSessionData.playerIds) ? gameSessionData.playerIds : [];
    const item = document.createElement("button");
    item.type = "button";
    item.className = "open-game-lobby";
    const title = document.createElement("strong");
    title.textContent = gameSessionData.gameName || game?.name || "Oyun";
    const playerCount = document.createElement("span");
    playerCount.textContent = players.length + "/" + (gameSessionData.maxPlayers || game?.maxPlayers || "?");
    item.append(title, playerCount);
    item.addEventListener("click", () => {
        $("gameSessionContent").hidden = false;
        $("gameCenterEmptyState").hidden = true;
        $("gameSessionContent").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    list.appendChild(item);
    count.textContent = "1";
}
function renderGameMemberList(containerId, memberIds, statusForMember = null) {
    const container = $(containerId);
    if (!container) return;
    container.replaceChildren();

    const ids = Array.isArray(memberIds) ? memberIds : [];
    if (!ids.length) {
        const empty = document.createElement("span");
        empty.className = "game-session-empty";
        empty.textContent = "Henüz kimse yok.";
        container.appendChild(empty);
        return;
    }

    ids.forEach((userId) => {
        const member = activeRoomMembers.find((item) => item.id === userId);
        const row = document.createElement("div");
        row.className = "game-session-member";
        const name = document.createElement("span");
        name.textContent = member?.displayNickname || member?.username || "Odadan ayrılmış üye";
        row.appendChild(name);
        const state = statusForMember?.(userId);
        if (state) {
            const badge = document.createElement("span");
            badge.className = "game-session-member-state";
            badge.textContent = state;
            row.appendChild(badge);
        }
        container.appendChild(row);
    });
}

function renderGameCenter() {
    const session = gameSessionData;
    const emptyState = $("gameCenterEmptyState");
    const content = $("gameSessionContent");
    if (!emptyState || !content) return;

    // Keep the game picker visible when returning to Games, even if this room
    // already has an active session. The session panel can render beneath it.
    emptyState.hidden = false;
    content.hidden = !session;
    renderGameCatalog();
    if (!session) {
        renderOpenGameLobbies();
        $("gameLobbySettingsPanel").hidden = true;
        $("gameLobbySettingsButton").hidden = true;
        $("gameBotLobbyPreview").hidden = true;
        return;
    }

    const players = Array.isArray(session.playerIds) ? session.playerIds : [];
    const vampirSettings = session.gameId === "vampir-koylu"
        ? getVampirLobbySettings(session)
        : null;
    const botFillEnabled = Boolean(vampirSettings?.botFillEnabled);
    const targetPlayerCount = vampirSettings?.targetPlayerCount || 5;
    const botSlotCount = botFillEnabled
        ? Math.max(0, targetPlayerCount - players.length)
        : 0;
    const readyIds = Array.isArray(session.readyIds) ? session.readyIds : [];
    const matchPlayers = Array.isArray(session.matchPlayerIds)
        ? session.matchPlayerIds
        : (["playing", "results"].includes(session.status) ? players : []);
    const spectators = Array.isArray(session.spectatorIds) ? session.spectatorIds : [];
    const resultReturnIds = Array.isArray(session.resultReturnIds) ? session.resultReturnIds : [];
    const hasReturnedFromWorkerResults =
        ["uno", "vampir-koylu"].includes(session.gameId) &&
        session.status === "results" &&
        resultReturnIds.includes(currentUser?.uid);
    const isPlaying = session.status === "playing";
    const isStarting = session.status === "starting";
    const isResults = session.status === "results";
    const gameDefinition = getGameDefinition(session.gameId);
    const { minPlayers, maxPlayers } = getGameLimits(session.gameId, session);
    const isLobbyPlayer = players.includes(currentUser?.uid);
    const isMatchPlayer = matchPlayers.includes(currentUser?.uid);
    const isSpectator = spectators.includes(currentUser?.uid);
    const canManage = Boolean(currentUser && (
        session.hostId === currentUser.uid || canCurrentUserKickMembers()
    ));

    renderOpenGameLobbies();
    $("gameSessionName").textContent = session.gameName || "Oda oyunu";
    const hostMember = activeRoomMembers.find((member) => member.id === session.hostId);
    $("gameSessionHost").textContent = hostMember?.displayNickname || hostMember?.username || "Oyuncu";

    const statusLabels = {
        lobby: "Lobi açık",
        starting: "Geri sayım başladı",
        playing: "Maç devam ediyor",
        results: "Maç sonuçlandı"
    };
    $("gameSessionStatus").textContent = statusLabels[session.status] || "Lobi açık";
    $("gameSessionStatus").classList.toggle("is-playing", isPlaying);
    $("gameSessionStatus").classList.toggle("is-starting", isStarting);
    $("gameSessionStatus").classList.toggle("is-results", isResults);

    $("gameSessionSummary").textContent = isPlaying
        ? `Maç ${session.round || 1} devam ediyor. Lobi üyeleri kalıcıdır; maç sırasında gelenler izleyici olarak eklenir.`
        : isStarting
            ? "Herkes hazır. Oyun 3 saniyelik geri sayımın sonunda başlayacak; biri vazgeçerse sayaç iptal edilir."
            : isResults
                ? ["uno", "vampir-koylu"].includes(session.gameId)
                    ? `Sonuç ekranı · ${resultReturnIds.length}/${matchPlayers.length} oyuncu lobiye döndü.`
                    : "Maç bitti. İzleyiciler otomatik olarak lobi üyelerine eklendi. Yeni maç için lobiye dön."
                : botFillEnabled
                    ? `Kalıcı lobi · ${players.length} gerçek oyuncu, ${botSlotCount} bot koltuğu. Tüm gerçek oyuncular hazır olunca ${targetPlayerCount} kişilik maç başlayacak.`
                    : `Kalıcı lobi · Maç ${session.round || 1}. En az ${minPlayers} gerçek oyuncu hazır olduğunda geri sayım başlayacak.`;

    const botPreview = $("gameBotLobbyPreview");
    const showBotPreview = session.gameId === "vampir-koylu" &&
        ["lobby", "starting"].includes(session.status);
    botPreview.hidden = !showBotPreview;
    if (showBotPreview) {
        botPreview.textContent = botFillEnabled
            ? `Gerçek oyuncu: ${players.length} · Bot: ${botSlotCount} · Toplam hedef: ${targetPlayerCount}`
            : `Botlar kapalı · Başlamak için en az 5 gerçek oyuncu gerekli.`;
    }

    $("gamePlayersHeading").textContent = "Lobi oyuncuları";
    $("gamePlayersCount").textContent = botFillEnabled
        ? `${players.length}+${botSlotCount}/${targetPlayerCount}`
        : `${players.length}/${maxPlayers}`;
    renderGameMemberList("gamePlayersList", players, (userId) => {
        if (userId === session.hostId && isPlaying && matchPlayers.includes(userId)) {
            return "Lobi sahibi · Maçta";
        }
        if (isPlaying) {
            return matchPlayers.includes(userId)
                ? "Maçta"
                : "Sonraki maç için lobide";
        }
        if (isResults) {
            if (["uno", "vampir-koylu"].includes(session.gameId) && resultReturnIds.includes(userId)) {
                return "Lobiye döndü";
            }
            return matchPlayers.includes(userId) ? "Sonuç ekranında" : "Lobi üyesi";
        }
        if (userId === session.hostId) {
            return readyIds.includes(userId) ? "Lobi sahibi · Hazır" : "Lobi sahibi";
        }
        return readyIds.includes(userId) ? "Hazır" : "Hazır bekliyor";
    });
    if (botFillEnabled && showBotPreview) {
        const list = $("gamePlayersList");
        for (let index = 0; index < botSlotCount; index += 1) {
            const row = document.createElement("div");
            row.className = "game-session-member game-session-bot-seat";
            const name = document.createElement("span");
            name.textContent = "Bot koltuğu " + (index + 1);
            const state = document.createElement("span");
            state.className = "game-session-member-state";
            state.textContent = "Maçta eklenecek";
            row.append(name, state);
            list.appendChild(row);
        }
    }

    // Only users who actually enter the game center during a live match appear here.
    $("gameSpectatorsCount").textContent = String(spectators.length);
    renderGameMemberList("gameSpectatorsList", spectators, () => "İzliyor");

    const nextRoundPlayers = Array.isArray(session.nextRoundPlayerIds)
        ? session.nextRoundPlayerIds
        : [];
    const isQueuedForNextRound = nextRoundPlayers.includes(currentUser?.uid);
    const canJoinLobby = session.status === "lobby" && !isLobbyPlayer;
    const canQueueForNextRound = isResults &&
        !isLobbyPlayer &&
        !isSpectator &&
        !isQueuedForNextRound;
    $("joinGameSessionButton").hidden = !(canJoinLobby || canQueueForNextRound);
    $("joinGameSessionButton").textContent = isResults ? "Lobiye gir" : "Lobiye katıl";
    $("readyGameSessionButton").hidden = !["lobby", "starting"].includes(session.status) || !isLobbyPlayer;
    $("leaveGameSessionButton").hidden = !(
        (["lobby", "starting", "results"].includes(session.status) && isLobbyPlayer) ||
        (isPlaying && (isLobbyPlayer || isMatchPlayer || isSpectator))
    );
    $("leaveGameSessionButton").textContent =
        isPlaying && isSpectator && !isLobbyPlayer
            ? "İzleyicilikten ayrıl"
            : "Lobiden ayrıl";

    const openMatchButton = $("openGameMatchButton");
    if (openMatchButton) {
        const canViewGame = ["playing", "results"].includes(session.status) &&
            (isMatchPlayer || isSpectator || (isResults && isLobbyPlayer)) &&
            !hasReturnedFromWorkerResults;
        openMatchButton.hidden = !(gameDefinition?.module && canViewGame);
        const gameName = gameDefinition?.name || "Oyun";
        openMatchButton.textContent = isResults
            ? gameName + " sonuçlarını gör"
            : isSpectator ? gameName + " masasını izle" : gameName + " ekranını aç";
    }
    $("finishGameRoundButton").hidden = !isPlaying || !canManage ||
        ["uno", "vampir-koylu"].includes(session.gameId);
    $("closeGameSessionButton").hidden = !canManage;
    $("closeGameSessionButton").textContent = "Lobiyi tamamen kapat";
    $("gameLobbySettingsButton").hidden = !(
        session.gameId === "vampir-koylu" &&
        session.status === "lobby" &&
        currentUser?.uid === session.hostId
    );
    if (
        currentUser?.uid !== session.hostId ||
        session.gameId !== "vampir-koylu" ||
        session.status !== "lobby"
    ) {
        $("gameLobbySettingsPanel").hidden = true;
    }

    if (!["playing", "results"].includes(session.status) && isLobbyPlayer) {
        $("readyGameSessionButton").textContent = readyIds.includes(currentUser?.uid)
            ? "Hazırım ✓ (geri al)"
            : "Hazırım";
    }

    if (isPlaying && isMatchPlayer) {
        setGameCenterStatus("Maçtasın. Oyun ekranındaki “Maçı terk et” seçeneği seni maçtan ve kalıcı oyun lobisinden çıkarır. İki kişilik maçta rakibin kazanır.");
    } else if (isPlaying && isSpectator) {
        setGameCenterStatus("Bu maçı izliyorsun. “İzleyicilikten ayrıl” seçeneği seni izleyici listesinden çıkarır.");
    } else if (isPlaying) {
        setGameCenterStatus("Lobide kalıyorsun. Buradaki “Lobiden ayrıl” seçeneği kalıcı üyeliğini sonlandırır.");
    } else if (isResults && isQueuedForNextRound) {
        setGameCenterStatus("Sonraki maç için lobiye katıldın. Sonuç ekranı kapanınca otomatik ekleneceksin.");
    } else if (isResults && canQueueForNextRound) {
        setGameCenterStatus("Maç sonuçlandı. Şimdi lobiye katılarak sonraki maçta yer alabilirsin.");
    } else if (isResults && hasReturnedFromWorkerResults) {
        const waiting = Math.max(0, matchPlayers.length - resultReturnIds.length);
        setGameCenterStatus(
            waiting > 0
                ? "Lobiye döndün. Diğer " + waiting + " aktif oyuncunun dönüşü bekleniyor."
                : "Tüm oyuncular döndü. Yeni lobi hazırlanıyor."
        );
    } else if (isResults) {
        setGameCenterStatus(["uno", "vampir-koylu"].includes(session.gameId)
            ? "Her oyuncunun sonuç ekranı 5 saniye içinde lobiye dönüşünü sunucuya kaydeder."
            : "Sonuçlar 5 saniye gösterilecek. Ardından lobi otomatik sıfırlanacak.");
    } else if (isStarting && isLobbyPlayer) {
        setGameCenterStatus("Geri sayım başladı. Hazır durumunu geri alarak maçı durdurabilirsin.");
    } else if (isLobbyPlayer) {
        setGameCenterStatus("Kalıcı oyun lobisindesin. Aktif maçta değilsin; sonraki maç için burada bekliyorsun.");
    } else {
        setGameCenterStatus("Lobiye katılarak kalıcı oyuncu olabilirsin.");
    }
}

function clearGameSessionCountdown() {
    if (gameSessionCountdownTimer) clearInterval(gameSessionCountdownTimer);
    gameSessionCountdownTimer = null;
    gameSessionCountdownEndAt = null;
}

function clearGameSessionResultsTimer() {
    if (gameSessionResultsTimer) clearTimeout(gameSessionResultsTimer);
    gameSessionResultsTimer = null;
    gameSessionResultsTimerKey = "";
}

async function returnUnoToLobbyFromResults(roomId, expectedRound) {
    if (!currentUser) throw new Error("Oturum bulunamadı.");

    const result = await returnUnoToLobby(
        db,
        roomId,
        expectedRound,
        currentUser.uid
    );

    if (result.completed) {
        setGameCenterStatus("Tüm aktif oyuncular lobiye döndü. Yeni UNO lobisi hazır.");
    } else {
        setGameCenterStatus(
            "Lobiye döndün. Diğer oyuncuların dönüşü bekleniyor (" +
            result.returnedCount + "/" + result.requiredCount + ")."
        );
    }

    return result;
}

async function returnVampirKoyluToLobbyFromResults(roomId, expectedRound, sessionId) {
    if (!currentUser) throw new Error("Oturum bulunamadı.");

    const result = await returnVampirKoyluToLobby(
        db,
        roomId,
        expectedRound,
        sessionId,
        currentUser.uid
    );

    if (result.completed) {
        setGameCenterStatus("Tüm oyuncular döndü. Yeni Vampir Köylü lobisi hazır.");
    } else {
        setGameCenterStatus(
            "Lobiye döndün. Diğer oyuncular bekleniyor (" +
            result.returnedCount + "/" + result.requiredCount + ")."
        );
    }

    return result;
}

function syncGameSessionResultsReset(roomId, sessionData) {
    // UNO advances only when a player presses the result screen's
    // "Lobi ekranına dön" button. Never silently reuse a result round.
    if (!sessionData || sessionData.status !== "results" ||
        ["uno", "vampir-koylu"].includes(sessionData.gameId)) {
        clearGameSessionResultsTimer();
        return;
    }

    const round = Number(sessionData.round) || 1;
    const resetKey = roomId + ":" + sessionData.gameId + ":" + round;
    if (gameSessionResultsTimer && gameSessionResultsTimerKey === resetKey) return;

    clearGameSessionResultsTimer();
    gameSessionResultsTimerKey = resetKey;

    const finishedAt = sessionData.finishedAt?.toMillis?.();
    const elapsed = Number.isFinite(finishedAt) ? Date.now() - finishedAt : 0;
    // Add a small client-side buffer; Firestore Rules also enforce the full 5 seconds server-side.
    const delay = Math.max(0, 5300 - Math.max(0, elapsed));

    gameSessionResultsTimer = setTimeout(async () => {
        gameSessionResultsTimer = null;
        if (activeRoomId !== roomId) return;

        try {
            await runTransaction(db, async (transaction) => {
                const ref = getGameSessionRef(roomId);
                const snapshot = await transaction.get(ref);
                if (!snapshot.exists()) return;

                const latest = snapshot.data();
                if (
                    latest.status !== "results" ||
                    latest.gameId !== sessionData.gameId ||
                    Number(latest.round) !== round
                ) return;

                transaction.update(ref, {
                    status: "lobby",
                    round: round + 1,
                    playerIds: [...new Set([
                        ...(Array.isArray(latest.playerIds) ? latest.playerIds : []),
                        ...(Array.isArray(latest.spectatorIds) ? latest.spectatorIds : []),
                        ...(latest.gameId === "uno" && Array.isArray(latest.nextRoundPlayerIds)
                            ? latest.nextRoundPlayerIds
                            : [])
                    ])],
                    readyIds: [],
                    matchPlayerIds: [],
                    spectatorIds: [],
                    nextRoundPlayerIds: [],
                    nextRoundReadyIds: [],
                    resultReturnIds: [],
                    startedAt: null,
                    countdownEndsAt: null,
                    finishedAt: null,
                    updatedAt: serverTimestamp()
                });
            });
        } catch (error) {
            console.warn("CACA automatic results reset failed:", error);
            if (activeRoomId === roomId && gameSessionData?.status === "results" &&
                Number(gameSessionData.round) === round) {
                setGameCenterStatus(
                    "Lobi otomatik sıfırlanamadı: " + (error.message || "Bilinmeyen hata"),
                    true
                );
                gameSessionResultsTimerKey = "";
                gameSessionResultsTimer = setTimeout(() => {
                    gameSessionResultsTimer = null;
                    syncGameSessionResultsReset(roomId, gameSessionData);
                }, 1000);
            }
        }
    }, delay);
}

async function completeGameStartCountdown(roomId, expectedEndAt, retry = 0) {
    if (activeRoomId !== roomId || gameSessionData?.status !== "starting") return;
    try {
        await runTransaction(db, async (transaction) => {
            const ref = getGameSessionRef(roomId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists()) return;
            const latest = snapshot.data();
            const endAt = latest.countdownEndsAt?.toMillis?.();
            if (latest.status !== "starting" || endAt !== expectedEndAt || endAt > Date.now()) return;

            if (!isLobbyReadyToStart(latest)) {
                // A player may have withdrawn readiness while another client was
                // completing the countdown. Never leave the session stuck in "starting".
                transaction.update(ref, {
                    status: "lobby",
                    countdownEndsAt: null,
                    updatedAt: serverTimestamp()
                });
                return;
            }

            transaction.update(ref, {
                status: "playing",
                matchPlayerIds: latest.playerIds,
                spectatorIds: [],
                readyIds: [],
                nextRoundPlayerIds: [],
                nextRoundReadyIds: [],
                startedAt: serverTimestamp(),
                countdownEndsAt: null,
                finishedAt: null,
                updatedAt: serverTimestamp()
            });
        });
    } catch (error) {
        if (
            error.code === "permission-denied" &&
            retry < 20 &&
            activeRoomId === roomId &&
            gameSessionData?.status === "starting"
        ) {
            setTimeout(() => completeGameStartCountdown(roomId, expectedEndAt, retry + 1), 1000);
            return;
        }
        if (activeRoomId === roomId) {
            console.warn("CACA game countdown completion failed:", error);
            setGameCenterStatus("Oyun başlatılamadı: " + (error.message || "Bilinmeyen hata"), true);
        }
    }
}

function syncGameSessionCountdown(roomId, sessionData) {
    if (sessionData?.status !== "starting") {
        clearGameSessionCountdown();
        return;
    }

    const endAt = sessionData.countdownEndsAt?.toMillis?.();
    if (!Number.isFinite(endAt)) {
        clearGameSessionCountdown();
        return;
    }
    if (gameSessionCountdownTimer && gameSessionCountdownEndAt === endAt) return;

    clearGameSessionCountdown();
    gameSessionCountdownEndAt = endAt;
    const tick = () => {
        if (activeRoomId !== roomId || gameSessionData?.status !== "starting") {
            clearGameSessionCountdown();
            return;
        }
        const remainingMs = endAt - Date.now();
        const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
        const status = $("gameSessionStatus");
        if (status) {
            status.textContent = remainingSeconds > 0
                ? `${remainingSeconds} sn içinde başlıyor`
                : "Maç başlıyor…";
        }
        if (remainingMs <= -500) {
            clearGameSessionCountdown();
            completeGameStartCountdown(roomId, endAt);
        }
    };
    gameSessionCountdownTimer = setInterval(tick, 150);
    tick();
}

async function maybeStartGameWhenReady(roomId, sessionData) {
    if (
        sessionData?.status !== "lobby" ||
        gameSessionStartInProgress ||
        !isLobbyReadyToStart(sessionData)
    ) return;

    gameSessionStartInProgress = true;
    try {
        await runTransaction(db, async (transaction) => {
            const ref = getGameSessionRef(roomId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists()) return;
            const latest = snapshot.data();
            if (latest.status !== "lobby" || !isLobbyReadyToStart(latest)) return;

            transaction.update(ref, {
                status: "starting",
                countdownEndsAt: Timestamp.fromMillis(Date.now() + 5000),
                updatedAt: serverTimestamp()
            });
        });
    } catch (error) {
        if (activeRoomId === roomId) {
            console.warn("CACA game countdown start failed:", error);
            if (error.code === "permission-denied") {
                setGameCenterStatus("Geri sayım başlatılamadı. Firestore Rules güncel olmalı.", true);
            }
        }
    } finally {
        gameSessionStartInProgress = false;
    }
}

let gameSpectatorJoinInProgress = false;

async function joinGameAsSpectator() {
    if (!currentUser || !activeRoomId || gameSpectatorJoinInProgress) return;
    gameSpectatorJoinInProgress = true;
    const roomId = activeRoomId;
    const uid = currentUser.uid;
    try {
        const result = await runTransaction(db, async (transaction) => {
            const ref = getGameSessionRef(roomId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists()) return "missing";
            const session = snapshot.data();
            if (session.status !== "playing") return "not-playing";

            const players = Array.isArray(session.playerIds) ? session.playerIds : [];
            const matchPlayers = Array.isArray(session.matchPlayerIds)
                ? session.matchPlayerIds
                : players;
            const spectators = Array.isArray(session.spectatorIds) ? session.spectatorIds : [];
            if (players.includes(uid) || matchPlayers.includes(uid) || spectators.includes(uid)) {
                return "already-listed";
            }

            const { maxPlayers } = getGameLimits(session.gameId, session);
            if (players.length + spectators.length >= maxPlayers) return "full";

            transaction.update(ref, {
                spectatorIds: arrayUnion(uid),
                updatedAt: serverTimestamp()
            });
            return "joined";
        });
        if (result === "full" && activeRoomId === roomId) {
            setGameCenterStatus("Bu maçın lobi kapasitesi dolu; izleyici listesine eklenemedin.", true);
        }
    } catch (error) {
        if (activeRoomId === roomId) {
            console.warn("CACA spectator join failed:", error);
            setGameCenterStatus("İzleyici olarak katılınamadı: " + (error.message || "Bilinmeyen hata"), true);
        }
    } finally {
        gameSpectatorJoinInProgress = false;
    }
}

async function openRoomGame(sessionData, { automatic = false } = {}) {
    if (!currentUser || !activeRoomId || !sessionData) return;

    const roomId = activeRoomId;
    const gameKey = roomId + ":" + sessionData.gameId + ":" + String(sessionData.round) +
        (sessionData.gameId === "vampir-koylu" ? ":" + String(sessionData.sessionId || "") : "");

    const isUserEligible = (latest) => {
        if (!latest || latest.gameId !== sessionData.gameId) return false;
        const matchPlayers = Array.isArray(latest.matchPlayerIds) ? latest.matchPlayerIds : [];
        const spectators = Array.isArray(latest.spectatorIds) ? latest.spectatorIds : [];
        if (latest.status === "playing") {
            return matchPlayers.includes(currentUser.uid) || spectators.includes(currentUser.uid);
        }
        if (latest.status === "results") {
            if (
                ["uno", "vampir-koylu"].includes(latest.gameId) &&
                Array.isArray(latest.resultReturnIds) &&
                latest.resultReturnIds.includes(currentUser.uid)
            ) return false;
            return matchPlayers.includes(currentUser.uid) ||
                spectators.includes(currentUser.uid) ||
                (Array.isArray(latest.playerIds) && latest.playerIds.includes(currentUser.uid));
        }
        return false;
    };

    if (automatic && !isUserEligible(sessionData)) return;

    // Do not reopen a table the user intentionally closed. A new round has a new key.
    if (
        activeRoomGame &&
        activeRoomGameKey === gameKey &&
        (automatic || !activeRoomGame.isClosed?.())
    ) return;
    if (openingRoomGameKey === gameKey) return;

    const requestId = ++roomGameOpenGeneration;
    openingRoomGameKey = gameKey;

    try {
        const definition = getGameDefinition(sessionData.gameId);
        if (!definition?.module) {
            if (!automatic) setGameCenterStatus("Bu oyunun ekran modülü bulunamadı.", true);
            return;
        }

        const modulePath = definition.module.startsWith("./")
            ? "../games/" + definition.module.slice(2)
            : definition.module;
        const gameModule = await import(modulePath);
        const game = gameModule.default || gameModule[sessionData.gameId + "Game"];
        if (!game || typeof game.open !== "function") {
            throw new Error("Oyun modülü open() arayüzünü dışa aktarmıyor.");
        }

        // The session may have advanced while the module was loading. Always use
        // the latest snapshot and cancel any request belonging to an old round.
        const latest = gameSessionData;
        const latestKey = latest
            ? roomId + ":" + latest.gameId + ":" + String(latest.round) +
                (latest.gameId === "vampir-koylu" ? ":" + String(latest.sessionId || "") : "")
            : "";
        if (
            requestId !== roomGameOpenGeneration ||
            activeRoomId !== roomId ||
            latestKey !== gameKey ||
            !isUserEligible(latest)
        ) return;

        const nextGame = await game.open({
            db,
            roomId,
            round: latest.round,
            uid: currentUser.uid,
            session: latest,
            roomMembers: activeRoomMembers,
            onLeave: leaveCurrentMatch,
            onReturnToLobby: Array.isArray(latest.matchPlayerIds) &&
                latest.matchPlayerIds.includes(currentUser.uid)
                ? latest.gameId === "uno"
                    ? () => returnUnoToLobbyFromResults(roomId, latest.round)
                    : latest.gameId === "vampir-koylu"
                        ? () => returnVampirKoyluToLobbyFromResults(roomId, latest.round, latest.sessionId)
                        : null
                : null
        });

        const current = gameSessionData;
        const currentKey = current
            ? roomId + ":" + current.gameId + ":" + String(current.round) +
                (current.gameId === "vampir-koylu" ? ":" + String(current.sessionId || "") : "")
            : "";
        if (
            requestId !== roomGameOpenGeneration ||
            activeRoomId !== roomId ||
            currentKey !== gameKey ||
            !isUserEligible(current)
        ) {
            nextGame?.close();
            return;
        }

        const previousGame = activeRoomGame;
        activeRoomGame = nextGame;
        activeRoomGameKey = gameKey;
        if (previousGame && previousGame !== nextGame) previousGame.close();
    } catch (error) {
        console.error("CACA room game launch failed:", error);
        if (activeRoomId === roomId && requestId === roomGameOpenGeneration) {
            setGameCenterStatus("Oyun ekranı açılamadı: " + (error.message || "Bilinmeyen hata"), true);
        }
    } finally {
        if (openingRoomGameKey === gameKey) openingRoomGameKey = "";
    }
}

function reconcileUnoRosterChange(roomId, sessionData) {
    if (
        !sessionData ||
        sessionData.gameId !== "uno" ||
        sessionData.status !== "playing" ||
        !currentUser
    ) return;

    const roundKey = roomId + ":" + String(sessionData.round);
    const currentIds = Array.isArray(sessionData.matchPlayerIds)
        ? sessionData.matchPlayerIds
        : [];
    if (observedUnoRosterRoundKey !== roundKey) {
        observedUnoRosterRoundKey = roundKey;
        observedUnoRosterIds = [...currentIds];
        return;
    }

    const previousIds = observedUnoRosterIds;
    observedUnoRosterIds = [...currentIds];
    const onlyPlayersLeft = currentIds.length < previousIds.length &&
        currentIds.every((id) => previousIds.includes(id));
    if (!onlyPlayersLeft || !currentIds.length || currentUser.uid !== currentIds[0]) return;

    reconcileUnoMatchPlayers(db, roomId, sessionData.round, currentUser.uid)
        .catch((error) => {
            console.warn("CACA UNO roster reconciliation failed:", error);
            if (activeRoomId === roomId) {
                setGameCenterStatus("Oyuncu ayrılışı eşitlenemedi: " + (error.message || "Bilinmeyen hata"), true);
            }
        });
}

function reconcileVampirKoyluRosterChange(roomId, sessionData) {
    if (
        !sessionData ||
        sessionData.gameId !== "vampir-koylu" ||
        sessionData.status !== "playing" ||
        !currentUser
    ) return;

    const roundKey = roomId + ":" + String(sessionData.round) + ":" + String(sessionData.sessionId || "");
    const currentIds = Array.isArray(sessionData.matchPlayerIds)
        ? sessionData.matchPlayerIds
        : [];
    if (observedVampirRosterRoundKey !== roundKey) {
        observedVampirRosterRoundKey = roundKey;
        observedVampirRosterIds = [...currentIds];
        return;
    }

    const previousIds = observedVampirRosterIds;
    observedVampirRosterIds = [...currentIds];
    const onlyPlayersLeft = currentIds.length < previousIds.length &&
        currentIds.every((id) => previousIds.includes(id));
    if (!onlyPlayersLeft || !currentIds.length || currentUser.uid !== currentIds[0]) return;

    reconcileVampirKoyluMatchPlayers(db, roomId, sessionData.round, sessionData.sessionId, currentUser.uid)
        .catch((error) => {
            console.warn("Vampir Köylü roster eşitlemesi başarısız:", error);
            if (activeRoomId === roomId) {
                setGameCenterStatus("Oyuncu ayrılışı eşitlenemedi: " + (error.message || "Bilinmeyen hata"), true);
            }
        });
}

function listenToGameCenter(roomId) {
    roomGameOpenGeneration += 1;
    openingRoomGameKey = "";
    observedUnoRosterRoundKey = "";
    observedUnoRosterIds = [];
    observedVampirRosterRoundKey = "";
    observedVampirRosterIds = [];
    clearGameSessionCountdown();
    clearGameSessionResultsTimer();
    if (unsubscribeGameSession) unsubscribeGameSession();
    activeRoomGame?.close();
    activeRoomGame = null;
    activeRoomGameKey = "";
    unsubscribeGameSession = onSnapshot(getGameSessionRef(roomId), (snapshot) => {
        if (activeRoomId !== roomId) return;
        const nextSession = snapshot.exists() ? snapshot.data() : null;
        if (
            nextSession?.gameId === "vampir-koylu" &&
            ["lobby", "starting", "playing", "results"].includes(nextSession.status) &&
            !nextSession.sessionId &&
            currentUser?.uid === nextSession.hostId
        ) {
            // One-time migration for a lobby created before session isolation existed.
            const migration = {
                sessionId: crypto.randomUUID(),
                updatedAt: serverTimestamp()
            };
            if (nextSession.status === "results") {
                // A fresh Durable Object has no old result state to acknowledge.
                // Move the abandoned legacy result screen into a clean next lobby.
                Object.assign(migration, {
                    status: "lobby",
                    round: (Number(nextSession.round) || 1) + 1,
                    readyIds: [],
                    matchPlayerIds: [],
                    spectatorIds: [],
                    nextRoundPlayerIds: [],
                    nextRoundReadyIds: [],
                    resultReturnIds: [],
                    startedAt: null,
                    countdownEndsAt: null,
                    finishedAt: null
                });
            }
            void updateDoc(getGameSessionRef(roomId), migration).catch((error) => {
                console.warn("CACA legacy Vampir lobby identity migration failed:", error);
            });
        }
        gameSessionData = nextSession;
        recordGameLobbyCooldown(roomId, gameSessionData);
        renderGameCenter();
        reconcileUnoRosterChange(roomId, gameSessionData);
        reconcileVampirKoyluRosterChange(roomId, gameSessionData);
        syncGameSessionCountdown(roomId, gameSessionData);
        syncGameSessionResultsReset(roomId, gameSessionData);
        if (gameSessionData) maybeStartGameWhenReady(roomId, gameSessionData);

        if (["playing", "results"].includes(gameSessionData?.status)) {
            const matchPlayers = Array.isArray(gameSessionData.matchPlayerIds)
                ? gameSessionData.matchPlayerIds
                : [];
            const spectators = Array.isArray(gameSessionData.spectatorIds)
                ? gameSessionData.spectatorIds
                : [];
            const persistentPlayers = Array.isArray(gameSessionData.playerIds)
                ? gameSessionData.playerIds
                : [];
            const canSeeCurrentGame = gameSessionData.status === "playing"
                ? matchPlayers.includes(currentUser?.uid) || spectators.includes(currentUser?.uid)
                : persistentPlayers.includes(currentUser?.uid) ||
                    matchPlayers.includes(currentUser?.uid) ||
                    spectators.includes(currentUser?.uid);
            if (canSeeCurrentGame) {
                void openRoomGame(gameSessionData, { automatic: true });
            } else {
                roomGameOpenGeneration += 1;
                openingRoomGameKey = "";
                activeRoomGame?.close();
                activeRoomGame = null;
                activeRoomGameKey = "";
            }
        } else if (!gameSessionData || gameSessionData.status === "lobby") {
            roomGameOpenGeneration += 1;
            openingRoomGameKey = "";
            activeRoomGame?.close();
            activeRoomGame = null;
            activeRoomGameKey = "";
        }

        if ($("gameCenterPanel") && !$("gameCenterPanel").hidden && gameSessionData?.status === "playing") {
            joinGameAsSpectator();
        }
    }, (error) => {
        if (activeRoomId !== roomId) return;
        console.warn("CACA game center listener failed:", error);
        setGameCenterStatus(
            error.code === "permission-denied"
                ? "Oyun lobisi okunamadı. Firestore Rules güncel olmalı."
                : "Oyun lobisi yüklenemedi: " + (error.message || "Bilinmeyen hata"),
            true
        );
    });
}

const gamePanel = $("gameCenterPanel");
const gamesMount = $("gamesPageMount");
if (gamePanel && gamesMount) {
    gamesMount.appendChild(gamePanel);
    gamePanel.hidden = false;
    gamePanel.classList.remove("room-management-panel");
    gamePanel.removeAttribute("role");
    gamePanel.removeAttribute("aria-modal");
}

let gamesTabPreviousVisibility = null;

function setWorkspaceTab(tab) {
    const showGames = tab === "games";
    const workspace = document.querySelector(".workspace-layout");
    const roomSidebar = document.querySelector(".room-sidebar");
    const dashboardView = $("dashboardView");
    const roomView = $("roomView");
    const gamesView = $("gamesView");

    if (showGames) {
        if (!gamesTabPreviousVisibility) {
            gamesTabPreviousVisibility = {
                sidebarHidden: Boolean(roomSidebar?.hidden),
                dashboardHidden: Boolean(dashboardView?.hidden),
                roomHidden: Boolean(roomView?.hidden)
            };
        }
        if (roomSidebar) roomSidebar.hidden = true;
        if (dashboardView) dashboardView.hidden = true;
        if (roomView) roomView.hidden = true;
        if (workspace) workspace.classList.add("is-games-workspace");
        gamesView.hidden = false;
        renderGameCenter();
        renderOpenGameLobbies();
        if (gameSessionData?.status === "playing") joinGameAsSpectator();
    } else {
        gamesView.hidden = true;
        if (workspace) workspace.classList.remove("is-games-workspace");
        if (roomSidebar) roomSidebar.hidden = gamesTabPreviousVisibility?.sidebarHidden ?? false;
        if (dashboardView) dashboardView.hidden = gamesTabPreviousVisibility?.dashboardHidden ?? !activeRoomId;
        if (roomView) roomView.hidden = gamesTabPreviousVisibility?.roomHidden ?? Boolean(!activeRoomId);
        gamesTabPreviousVisibility = null;
    }

    $("settingsView").hidden = true;
    $("chatsNavButton").classList.toggle("is-active", !showGames);
    $("gamesNavButton").classList.toggle("is-active", showGames);
    $("chatsNavButton").setAttribute("aria-pressed", String(!showGames));
    $("gamesNavButton").setAttribute("aria-pressed", String(showGames));
}

$("chatsNavButton").addEventListener("click", () => setWorkspaceTab("chats"));
$("gamesNavButton").addEventListener("click", () => setWorkspaceTab("games"));
$("closeGameCenterButton").addEventListener("click", () => setWorkspaceTab("chats"));
$("gameCatalogGrid").addEventListener("click", (event) => {
    const card = event.target.closest(".game-catalog-card[data-game-id]");
    if (!card || card.disabled) return;
    selectedGameId = card.dataset.gameId;
    renderGameCatalog();
});

function updateGameBotSettingsPreview() {
    const session = gameSessionData;
    const enabled = $("gameBotFillToggle").checked;
    const target = Number($("gameBotTargetCount").value);
    const humanCount = Array.isArray(session?.playerIds) ? session.playerIds.length : 0;
    const preview = $("gameBotSettingsPreview");
    const saveButton = $("saveGameLobbySettingsButton");
    const remaining = target - humanCount;

    if (!Number.isInteger(target) || target < 5 || target > 12) {
        preview.textContent = "Hedef oyuncu sayısı 5–12 arasında olmalı.";
        saveButton.disabled = true;
        return;
    }
    if (enabled && remaining < 0) {
        preview.textContent = "Hedef sayı mevcut gerçek oyuncu sayısından düşük olamaz.";
        saveButton.disabled = true;
        return;
    }

    preview.textContent = enabled
        ? `${humanCount} gerçek oyuncu + ${Math.max(0, remaining)} bot = ${target} toplam oyuncu.`
        : `Botlar kapalı. Başlamak için en az 5 gerçek oyuncu gerekiyor. Şu an ${humanCount} gerçek oyuncu var.`;
    saveButton.disabled = false;
}

function openGameLobbySettings() {
    const session = gameSessionData;
    if (
        !currentUser ||
        !session ||
        session.gameId !== "vampir-koylu" ||
        session.status !== "lobby" ||
        session.hostId !== currentUser.uid
    ) {
        setGameCenterStatus("Lobi ayarlarını yalnızca lobi sahibi ve yalnızca lobi açıkken değiştirebilir.", true);
        return;
    }

    const settings = getVampirLobbySettings(session);
    $("gameBotFillToggle").checked = settings.botFillEnabled;
    $("gameBotTargetCount").value = String(settings.targetPlayerCount);
    $("gameBotSettingsStatus").textContent = "";
    $("gameLobbySettingsPanel").hidden = false;
    updateGameBotSettingsPreview();
    $("closeGameLobbySettingsButton").focus();
}

function closeGameLobbySettings() {
    $("gameLobbySettingsPanel").hidden = true;
    $("gameLobbySettingsButton").focus();
}

async function saveGameLobbySettings() {
    const session = gameSessionData;
    if (!currentUser || !activeRoomId || !session) return;

    const roomId = activeRoomId;
    const uid = currentUser.uid;
    const botFillEnabled = $("gameBotFillToggle").checked;
    const targetPlayerCount = Number($("gameBotTargetCount").value);
    const button = $("saveGameLobbySettingsButton");

    if (
        session.gameId !== "vampir-koylu" ||
        session.status !== "lobby" ||
        session.hostId !== uid
    ) {
        $("gameBotSettingsStatus").textContent = "Bu ayarları değiştirme yetkin yok veya maç başladı.";
        return;
    }
    if (!Number.isInteger(targetPlayerCount) || targetPlayerCount < 5 || targetPlayerCount > 12) {
        $("gameBotSettingsStatus").textContent = "Hedef oyuncu sayısı 5–12 arasında olmalı.";
        return;
    }

    button.disabled = true;
    $("gameBotSettingsStatus").textContent = "Ayarlar kaydediliyor…";
    try {
        await runTransaction(db, async (transaction) => {
            const ref = getGameSessionRef(roomId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists()) throw new Error("Oyun lobisi artık mevcut değil.");
            const latest = snapshot.data();
            if (
                latest.gameId !== "vampir-koylu" ||
                latest.status !== "lobby" ||
                latest.hostId !== uid
            ) {
                throw new Error("Yalnızca lobi sahibi, maç başlamadan ayarları değiştirebilir.");
            }
            const playerCount = Array.isArray(latest.playerIds) ? latest.playerIds.length : 0;
            if (botFillEnabled && playerCount > targetPlayerCount) {
                throw new Error("Hedef oyuncu sayısı gerçek oyuncu sayısından düşük olamaz.");
            }

            transaction.update(ref, {
                gameSettings: { botFillEnabled, targetPlayerCount },
                updatedAt: serverTimestamp()
            });
        });
        $("gameBotSettingsStatus").textContent = "Lobi ayarları kaydedildi.";
        setGameCenterStatus("Vampir Köylü lobi ayarları güncellendi.");
        $("gameLobbySettingsPanel").hidden = true;
    } catch (error) {
        $("gameBotSettingsStatus").textContent = error.message || "Ayarlar kaydedilemedi.";
    } finally {
        button.disabled = false;
    }
}

async function createGameSession() {
    if (!currentUser || !activeRoomId) {
        setGameCenterStatus("Önce bir odaya girmen gerekiyor.", true);
        return;
    }
    const selectedGame = GAME_REGISTRY.find((game) =>
        game.id === selectedGameId && game.lobbyEnabled !== false
    );
    if (!selectedGame) {
        setGameCenterStatus("Önce lobi oluşturulabilen bir oyun seçmelisin.", true);
        return;
    }
    if (gameSessionData) {
        setGameCenterStatus("Bu odada zaten açık bir oyun lobisi var.");
        renderGameCenter();
        return;
    }
    const cooldownRemaining = getGameLobbyCooldownUntil() - Date.now();
    if (cooldownRemaining > 0) {
        setGameCenterStatus(`Yeni lobi oluşturmak için ${Math.ceil(cooldownRemaining / 1000)} saniye beklemelisin.`);
        renderGameCatalog();
        return;
    }
    const button = $("createGameSessionButton");
    button.disabled = true;
    setGameCenterStatus("Kalıcı oyun lobisi oluşturuluyor...");
    try {
        await setDoc(getGameSessionRef(), {
            ...(selectedGame.id === "vampir-koylu" ? { sessionId: crypto.randomUUID() } : {}),
            gameId: selectedGame.id,
            gameName: selectedGame.name,
            maxPlayers: Math.min(selectedGame.maxPlayers, Math.max(selectedGame.minPlayers, Number($("gameMaxPlayersSelect")?.value) || selectedGame.maxPlayers)),
            status: "lobby",
            round: 1,
            hostId: currentUser.uid,
            playerIds: [currentUser.uid],
            readyIds: [],
            matchPlayerIds: [],
            spectatorIds: [],
            nextRoundPlayerIds: [],
            nextRoundReadyIds: [],
            resultReturnIds: [],
            ...(selectedGame.id === "vampir-koylu"
                ? { gameSettings: { botFillEnabled: false, targetPlayerCount: 5 } }
                : {}),
            createdAt: serverTimestamp(),
            startedAt: null,
            countdownEndsAt: null,
            finishedAt: null,
            updatedAt: serverTimestamp()
        });
        setGameCenterStatus("Kalıcı lobi kuruldu. Oyuncular katılabilir.");
    } catch (error) {
        console.error("CACA game session create failed:", error);
        setGameCenterStatus(
            error.code === "permission-denied"
                ? "Lobi açılamadı: Firestore Rules güncel olmalı."
                : "Lobi açılamadı: " + (error.message || "Bilinmeyen hata"),
            true
        );
    } finally {
        button.disabled = false;
    }
}

async function joinGameSession() {
    if (!currentUser || !gameSessionData || !["lobby", "results"].includes(gameSessionData.status)) return;

    const uid = currentUser.uid;
    const session = gameSessionData;
    const players = Array.isArray(session.playerIds) ? session.playerIds : [];
    const spectators = Array.isArray(session.spectatorIds) ? session.spectatorIds : [];
    const queuedPlayers = Array.isArray(session.nextRoundPlayerIds) ? session.nextRoundPlayerIds : [];
    const baseLimits = getGameLimits(session.gameId, session);
    const lobbySettings = session.gameId === "vampir-koylu"
        ? getVampirLobbySettings(session)
        : null;
    const maxPlayers = lobbySettings?.botFillEnabled
        ? lobbySettings.targetPlayerCount
        : baseLimits.maxPlayers;

    if (session.status === "results") {
        if (players.includes(uid) || spectators.includes(uid) || queuedPlayers.includes(uid)) {
            return;
        }

        const occupiedSeats = players.length + spectators.length + queuedPlayers.length;
        if (occupiedSeats >= maxPlayers) {
            setGameCenterStatus(`Sonraki maçın lobisi dolu. En fazla ${maxPlayers} oyuncu katılabilir.`, true);
            return;
        }

        const button = $("joinGameSessionButton");
        if (button) button.disabled = true;
        try {
            await updateDoc(getGameSessionRef(), {
                nextRoundPlayerIds: arrayUnion(uid),
                updatedAt: serverTimestamp()
            });
            setGameCenterStatus("Sonraki maç için lobiye katıldın. Sonuçlar bitince otomatik ekleneceksin.");
        } catch (error) {
            setGameCenterStatus("Sonraki lobiye katılamadın: " + (error.message || "Bilinmeyen hata"), true);
        } finally {
            if (button) button.disabled = false;
        }
        return;
    }

    if (session.status !== "lobby") return;
    if (!players.includes(uid) && players.length >= maxPlayers) {
        setGameCenterStatus(`Lobi dolu. Bu oyun en fazla ${maxPlayers} oyuncu alabilir.`, true);
        return;
    }
    try {
        await updateDoc(getGameSessionRef(), {
            playerIds: arrayUnion(uid),
            updatedAt: serverTimestamp()
        });
        setGameCenterStatus("Kalıcı lobiye katıldın. Hazır olduğunda hazır butonuna bas.");
    } catch (error) {
        setGameCenterStatus("Lobiye katılamadın: " + (error.message || "Bilinmeyen hata"), true);
    }
}

let gameReadyToggleInProgress = false;

async function toggleGameReady() {
    if (!currentUser || !activeRoomId || gameReadyToggleInProgress) return;

    const roomId = activeRoomId;
    const uid = currentUser.uid;
    const button = $("readyGameSessionButton");
    gameReadyToggleInProgress = true;
    if (button) button.disabled = true;

    try {
        const result = await runTransaction(db, async (transaction) => {
            const ref = getGameSessionRef(roomId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists()) return { state: "missing" };

            const latest = snapshot.data();
            if (!["lobby", "starting"].includes(latest.status)) {
                return { state: "already-started" };
            }

            const players = Array.isArray(latest.playerIds) ? latest.playerIds : [];
            if (!players.includes(uid)) return { state: "not-player" };

            const readyIds = Array.isArray(latest.readyIds) ? latest.readyIds : [];
            const wasReady = readyIds.includes(uid);
            if (latest.status === "starting" && !wasReady) {
                return { state: "countdown-started" };
            }

            const updates = {
                readyIds: wasReady ? arrayRemove(uid) : arrayUnion(uid),
                updatedAt: serverTimestamp()
            };
            if (latest.status === "starting" && wasReady) {
                updates.status = "lobby";
                updates.countdownEndsAt = null;
            }

            transaction.update(ref, updates);
            return {
                state: latest.status === "starting" ? "cancelled" : wasReady ? "unready" : "ready"
            };
        });

        if (result.state === "cancelled") {
            setGameCenterStatus("Hazır durumunu geri aldın. Geri sayım iptal edildi.");
        } else if (result.state === "already-started") {
            setGameCenterStatus("Maç zaten başladı. Oyun ekranı eşitleniyor.");
        } else if (result.state === "not-player") {
            setGameCenterStatus("Hazır durumunu değiştirmek için önce kalıcı lobiye katılmalısın.", true);
        } else if (result.state === "missing") {
            setGameCenterStatus("Oyun lobisi artık mevcut değil.", true);
        } else if (result.state === "countdown-started") {
            setGameCenterStatus("Geri sayım başlamış. Hazır durumun sunucuda zaten kaldırılmış olabilir.");
        }
    } catch (error) {
        setGameCenterStatus("Hazır durumu değiştirilemedi: " + (error.message || "Bilinmeyen hata"), true);
    } finally {
        gameReadyToggleInProgress = false;
        if (button?.isConnected) button.disabled = false;
    }
}

async function leaveUnoMatchFromSession(roomId, session, uid) {
    if (session?.gameId !== "uno" || !Number.isInteger(Number(session.round))) {
        throw new Error("UNO tur bilgisi bulunamadı.");
    }

    try {
        return await forfeitUnoMatch(db, roomId, Number(session.round), uid);
    } catch (error) {
        const wrapped = new Error(error?.message || "UNO maçından çıkış başarısız.");
        wrapped.code = error?.code;
        throw wrapped;
    }
}

async function leaveVampirKoyluMatchFromSession(roomId, session, uid) {
    if (session?.gameId !== "vampir-koylu" || !Number.isInteger(Number(session.round))) {
        throw new Error("Vampir Köylü tur bilgisi bulunamadı.");
    }

    try {
        return await forfeitVampirKoyluMatch(db, roomId, Number(session.round), session.sessionId, uid);
    } catch (error) {
        const wrapped = new Error(error?.message || "Vampir Köylü maçından çıkış başarısız.");
        wrapped.code = error?.code;
        throw wrapped;
    }
}

async function leaveGameLobby() {
    if (
        !currentUser ||
        !gameSessionData ||
        !["lobby", "starting", "playing", "results"].includes(gameSessionData.status)
    ) return false;

    const uid = currentUser.uid;
    const initialSession = gameSessionData;
    const leaveButton = $("leaveGameSessionButton");
    if (leaveButton) leaveButton.disabled = true;

    const initialMatchPlayers = Array.isArray(initialSession.matchPlayerIds)
        ? initialSession.matchPlayerIds
        : (["playing", "results"].includes(initialSession.status)
            ? initialSession.playerIds || []
            : []);

    // Worker-backed games process exits on the authoritative game server,
    // including the case where the final active player leaves.
    if (
        initialMatchPlayers.includes(uid) &&
        (
            (initialSession.status === "playing" &&
                ["uno", "vampir-koylu"].includes(initialSession.gameId)) ||
            (initialSession.status === "results" && initialSession.gameId === "vampir-koylu")
        )
    ) {
        try {
            const result = initialSession.gameId === "uno"
                ? await leaveUnoMatchFromSession(activeRoomId, initialSession, uid)
                : await leaveVampirKoyluMatchFromSession(activeRoomId, initialSession, uid);

            activeRoomGame?.close();
            activeRoomGame = null;
            activeRoomGameKey = "";

            if (initialSession.gameId === "uno" && result.finished && result.winner) {
                const winner = activeRoomMembers.find((member) => member.id === result.winner);
                setGameCenterStatus(
                    (winner?.displayNickname || winner?.username || "Rakibin") +
                    " maçı terk ettiğin için kazandı."
                );
            } else if (initialSession.gameId === "vampir-koylu" && result.finished && result.winner) {
                setGameCenterStatus(
                    (result.winner === "vampirler" ? "Vampirler" : "Köylüler") +
                    " maçı kazandı. Maçtan ayrıldın."
                );
            } else {
                setGameCenterStatus("Maçı terk ettin. Oyun lobisinden de çıkarıldın.");
            }
            return true;
        } catch (error) {
            const code = error?.code ? " (" + error.code + ")" : "";
            setGameCenterStatus(
                "Maçı terk edemedin: " + (error?.message || "Bilinmeyen hata") + code,
                true
            );
            return false;
        } finally {
            if (leaveButton) leaveButton.disabled = false;
        }
    }

    try {
        const result = await runTransaction(db, async (transaction) => {
            const ref = getGameSessionRef();
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists()) return { left: false };

            const latest = snapshot.data();
            if (!["lobby", "starting", "playing", "results"].includes(latest.status)) {
                return { left: false };
            }

            const players = Array.isArray(latest.playerIds) ? latest.playerIds : [];
            const readyIds = Array.isArray(latest.readyIds) ? latest.readyIds : [];
            const matchPlayers = Array.isArray(latest.matchPlayerIds)
                ? latest.matchPlayerIds
                : (["playing", "results"].includes(latest.status) ? players : []);
            const spectators = Array.isArray(latest.spectatorIds) ? latest.spectatorIds : [];
            const isPlayer = players.includes(uid);
            const isMatchPlayer = matchPlayers.includes(uid);
            const isSpectator = spectators.includes(uid);

            if (!isPlayer && !isMatchPlayer && !isSpectator) return { left: false };

            const remainingPlayers = players.filter((id) => id !== uid);
            const remainingReady = readyIds.filter((id) => id !== uid);
            const remainingMatchPlayers = matchPlayers.filter((id) => id !== uid);
            const remainingSpectators = spectators.filter((id) => id !== uid);
            const isHost = latest.hostId === uid;

            if (isHost && remainingPlayers.length === 0) {
                transaction.delete(ref);
                return { left: true, closed: true };
            }

            const isLastMatchPlayer = latest.status === "playing" &&
                isMatchPlayer &&
                matchPlayers.length === 1;

            if (isLastMatchPlayer) {
                // No active player remains. Reset the persistent lobby for a
                // fresh match instead of trapping the final player in it.
                const updates = {
                    status: "lobby",
                    round: (Number(latest.round) || 1) + 1,
                    playerIds: remainingPlayers,
                    readyIds: [],
                    matchPlayerIds: [],
                    spectatorIds: [],
                    nextRoundPlayerIds: [],
                    nextRoundReadyIds: [],
                    startedAt: null,
                    countdownEndsAt: null,
                    finishedAt: null,
                    updatedAt: serverTimestamp()
                };
                if (isHost) updates.hostId = remainingPlayers[0];
                transaction.update(ref, updates);
                return { left: true, reset: true, hostChanged: isHost };
            }

            const updates = {
                playerIds: remainingPlayers,
                readyIds: remainingReady,
                updatedAt: serverTimestamp()
            };
            if (Array.isArray(latest.resultReturnIds) && latest.resultReturnIds.includes(uid)) {
                updates.resultReturnIds = latest.resultReturnIds.filter((id) => id !== uid);
            }
            if (Array.isArray(latest.matchPlayerIds) && isMatchPlayer) {
                updates.matchPlayerIds = remainingMatchPlayers;
            }
            if (Array.isArray(latest.spectatorIds) && isSpectator) {
                updates.spectatorIds = remainingSpectators;
            }
            if (latest.status === "starting") {
                updates.status = "lobby";
                updates.countdownEndsAt = null;
            }
            if (isHost) updates.hostId = remainingPlayers[0];

            transaction.update(ref, updates);
            return { left: true, hostChanged: isHost };
        });

        if (result.left) {
            activeRoomGame?.close();
            activeRoomGame = null;
            activeRoomGameKey = "";
        }

        if (result.closed) {
            setGameCenterStatus("Lobide başka oyuncu kalmadığı için lobi kapatıldı.");
        } else if (result.reset) {
            setGameCenterStatus("Son maç oyuncusu ayrıldı. Lobi yeni maç için sıfırlandı.");
        } else if (result.hostChanged) {
            setGameCenterStatus("Lobiden ayrıldın. Lobi sahipliği sıradaki üyeye devredildi.");
        } else if (result.left) {
            setGameCenterStatus("Oyun lobisinden ayrıldın.");
        }
        return Boolean(result.left);
    } catch (error) {
        setGameCenterStatus("Lobiden ayrılamadın: " + (error.message || "Bilinmeyen hata"), true);
        return false;
    } finally {
        if (leaveButton) leaveButton.disabled = false;
    }
}

async function leaveCurrentMatch() {
    if (!currentUser || !activeRoomId) return false;
    const gameId = gameSessionData?.gameId;
    if (!["uno", "vampir-koylu"].includes(gameId)) return false;

    const result = gameId === "uno"
        ? await leaveUnoMatchFromSession(activeRoomId, gameSessionData, currentUser.uid)
        : await leaveVampirKoyluMatchFromSession(activeRoomId, gameSessionData, currentUser.uid);
    if (!result.left) return false;

    if (gameId === "uno" && result.finished && result.winner) {
        const winner = activeRoomMembers.find((member) => member.id === result.winner);
        setGameCenterStatus(
            (winner?.displayNickname || winner?.username || "Rakibin") +
            " maçı terk ettiğin için kazandı."
        );
    } else if (gameId === "vampir-koylu" && result.finished && result.winner) {
        setGameCenterStatus(
            (result.winner === "vampirler" ? "Vampirler" : "Köylüler") + " kazandı."
        );
    } else if (result.cancelledBeforeStart || result.cancelledBeforeDeal) {
        setGameCenterStatus("Maç başlamadan terk edildi. Kalan oyuncular lobiye döndü.");
    } else {
        setGameCenterStatus("Maçı terk ettin. Oyun lobisinden de çıkarıldın.");
    }
    return true;
}

async function finishGameMatch() {
    if (!currentUser || !gameSessionData || gameSessionData.status !== "playing") return;
    const session = gameSessionData;
    if (session.hostId !== currentUser.uid && !canCurrentUserKickMembers()) return;

    try {
        await runTransaction(db, async (transaction) => {
            const ref = getGameSessionRef();
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists()) return;
            const latest = snapshot.data();
            if (latest.status !== "playing") return;

            const players = Array.isArray(latest.playerIds) ? latest.playerIds : [];
            const spectators = Array.isArray(latest.spectatorIds) ? latest.spectatorIds : [];
            const matchPlayers = Array.isArray(latest.matchPlayerIds)
                ? latest.matchPlayerIds
                : players;
            const persistentPlayers = [...new Set([...players, ...spectators])];

            transaction.update(ref, {
                status: "results",
                playerIds: persistentPlayers,
                readyIds: [],
                matchPlayerIds: matchPlayers,
                spectatorIds: [],
                nextRoundPlayerIds: [],
                nextRoundReadyIds: [],
                finishedAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        });
        setGameCenterStatus("Maç tamamlandı. İzleyiciler kalıcı lobiye eklendi.");
    } catch (error) {
        setGameCenterStatus("Maç bitirilemedi: " + (error.message || "Bilinmeyen hata"), true);
    }
}

async function closeGameSession() {
    if (!currentUser || !gameSessionData) return;
    if (gameSessionData.hostId !== currentUser.uid && !canCurrentUserKickMembers()) return;
    if (!window.confirm("Bu odanın kalıcı oyun lobisini tamamen kapatmak istiyor musun?")) return;
    try {
        await deleteDoc(getGameSessionRef());
        setGameCenterStatus("Kalıcı oyun lobisi kapatıldı.");
    } catch (error) {
        setGameCenterStatus("Lobi kapatılamadı: " + (error.message || "Bilinmeyen hata"), true);
    }
}

$("createGameSessionButton").addEventListener("click", createGameSession);
$("gameLobbySettingsButton").addEventListener("click", openGameLobbySettings);
$("closeGameLobbySettingsButton").addEventListener("click", closeGameLobbySettings);
$("cancelGameLobbySettingsButton").addEventListener("click", closeGameLobbySettings);
$("saveGameLobbySettingsButton").addEventListener("click", saveGameLobbySettings);
$("gameBotFillToggle").addEventListener("change", updateGameBotSettingsPreview);
$("gameBotTargetCount").addEventListener("change", updateGameBotSettingsPreview);
$("gameLobbySettingsPanel").addEventListener("click", (event) => {
    if (event.target === $("gameLobbySettingsPanel")) closeGameLobbySettings();
});
$("openGameMatchButton")?.addEventListener("click", async () => {
    if (!currentUser || !activeRoomId || !gameSessionData ||
        !["playing", "results"].includes(gameSessionData.status)) return;

    const button = $("openGameMatchButton");
    button.disabled = true;
    await openRoomGame(gameSessionData);
    button.disabled = false;
});
$("joinGameSessionButton").addEventListener("click", joinGameSession);
$("readyGameSessionButton").addEventListener("click", toggleGameReady);
$("leaveGameSessionButton").addEventListener("click", leaveGameLobby);
$("finishGameRoundButton").addEventListener("click", finishGameMatch);
$("closeGameSessionButton").addEventListener("click", closeGameSession);

// ROOM-WIDE PRANK EVENTS

function hideRoomPrank() {
    const overlay = $("roomPrankOverlay");
    if (!overlay) return;

    overlay.hidden = true;
    overlay.classList.remove("is-active");

    const customImage = $("roomPrankCustomImage");
    if (customImage) {
        customImage.hidden = true;
        customImage.removeAttribute("src");
    }

    if (prankOverlayTimer) {
        clearTimeout(prankOverlayTimer);
        prankOverlayTimer = null;
    }
}

function showRoomPrank(type, imageData = null, durationMs = 5000) {
    if (type === "custom-jumpscare" || type === "jumpscare") {
        if (typeof imageData !== "string" || !/^data:image\/(webp|jpeg);base64,/.test(imageData)) {
            return;
        }

        const overlay = $("roomPrankOverlay");
        const customImage = $("roomPrankCustomImage");
        if (!overlay || !customImage) return;

        const allowedDurations = [3000, 5000, 10000, 15000];
        const safeDurationMs = allowedDurations.includes(Number(durationMs))
            ? Number(durationMs)
            : 5000;

        hideRoomPrank();
        customImage.src = imageData;
        customImage.hidden = false;
        overlay.hidden = false;
        requestAnimationFrame(() => overlay.classList.add("is-active"));

        // The recipient can dismiss early with Escape; otherwise close on timeout.
        prankOverlayTimer = setTimeout(hideRoomPrank, safeDurationMs);
        return;
    }

    if (type === "shake") {
        document.body.classList.remove("room-screen-shake");
        void document.body.offsetWidth;
        document.body.classList.add("room-screen-shake");

        if (prankShakeTimer) clearTimeout(prankShakeTimer);
        prankShakeTimer = setTimeout(() => {
            document.body.classList.remove("room-screen-shake");
            prankShakeTimer = null;
        }, 850);
    }
}

function listenToRoomPranks(roomId) {
    if (unsubscribePranks) {
        unsubscribePranks();
        unsubscribePranks = null;
    }

    const prankRef = doc(db, "rooms", roomId, "pranks", "active");
    unsubscribePranks = onSnapshot(
        prankRef,
        (snapshot) => {
            if (activeRoomId !== roomId || !snapshot.exists()) return;

            const prank = snapshot.data();
            const eventId = prank.eventId;
            const createdAt = prank.createdAt?.toMillis
                ? prank.createdAt.toMillis()
                : null;

            // Ignore the persistent last event when users first enter a room.
            // Only a newly-sent event from the last few seconds can play.
            if (
                typeof eventId !== "string" ||
                !eventId ||
                eventId === lastSeenPrankEventId ||
                createdAt === null ||
                Date.now() - createdAt > 10000 ||
                createdAt - Date.now() > 10000
            ) {
                return;
            }

            lastSeenPrankEventId = eventId;
            showRoomPrank(prank.type);
        },
        (error) => {
            if (activeRoomId === roomId) {
                console.warn("CACA room prank listener failed:", error);
            }
        }
    );
}

function listenToPersonalPranks(roomId) {
    if (unsubscribePersonalPranks) {
        unsubscribePersonalPranks();
        unsubscribePersonalPranks = null;
    }
    const inboxRef = doc(db, "rooms", roomId, "prankInbox", currentUser.uid);
    unsubscribePersonalPranks = onSnapshot(inboxRef, (snapshot) => {
        if (activeRoomId !== roomId || !snapshot.exists()) return;
        const prank = snapshot.data();
        const eventId = prank.eventId;
        const sentAt = prank.sentAt?.toMillis ? prank.sentAt.toMillis() : null;
        const durationMs = [3000, 5000, 10000, 15000].includes(Number(prank.durationMs))
            ? Number(prank.durationMs)
            : 5000;
        if (
            typeof eventId !== "string" || !eventId ||
            eventId === lastSeenPersonalPrankEventId ||
            prank.type !== "custom-jumpscare" ||
            typeof prank.imageData !== "string" ||
            !/^data:image\/(webp|jpeg);base64,/.test(prank.imageData) ||
            sentAt === null ||
            Date.now() - sentAt > durationMs + 5000 ||
            sentAt - Date.now() > 10000
        ) return;

        lastSeenPersonalPrankEventId = eventId;
        showRoomPrank("custom-jumpscare", prank.imageData, durationMs);
    }, (error) => {
        if (activeRoomId === roomId) console.warn("CACA personal jumpscare listener failed:", error);
    });
}

async function dispatchRoomPrank(type) {
    if (!currentUser || !activeRoomId || !canCurrentUserKickMembers()) {
        $("trollManagementStatus").textContent =
            "Bu araçları yalnızca oda sahibi ve aktif yöneticiler kullanabilir.";
        return;
    }

    if (type !== "shake") return;

    const now = Date.now();
    if (now - lastPrankDispatchAt < 6000) {
        $("trollManagementStatus").textContent =
            "Bir troll daha göndermeden önce birkaç saniye bekle.";
        return;
    }

    const button = $("shakeButton");
    const originalText = button.textContent;
    button.disabled = true;
    lastPrankDispatchAt = now;
    $("trollManagementStatus").textContent = "Odaya gönderiliyor...";

    try {
        await setDoc(
            doc(db, "rooms", activeRoomId, "pranks", "active"),
            {
                eventId: crypto.randomUUID(),
                type,
                senderId: currentUser.uid,
                senderName: currentUsername || "Oda yöneticisi",
                createdAt: serverTimestamp()
            }
        );

        $("trollManagementStatus").textContent = "Ekran sallama efekti odaya gönderildi.";
    } catch (error) {
        lastPrankDispatchAt = 0;
        $("trollManagementStatus").textContent =
            error.code === "permission-denied"
                ? "Gönderilemedi. Firestore Rules içindeki oda yönetim araçları iznini yayımla."
                : "Gönderilemedi: " + (error.message || "Bilinmeyen hata");
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

$("shakeButton")?.addEventListener("click", () => {
    dispatchRoomPrank("shake");
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("roomPrankOverlay")?.hidden) {
        event.preventDefault();
        hideRoomPrank();
    }
});

// EMOJI PICKER AND SHORTCODES

const CHAT_EMOJIS = EMOJI_DATA;
const EMOJI_CATEGORIES = [
    { id: "Smileys & Emotion", label: "Yüzler" },
    { id: "People & Body", label: "İnsanlar" },
    { id: "Animals & Nature", label: "Doğa" },
    { id: "Food & Drink", label: "Yiyecek ve içecek" },
    { id: "Symbols", label: "Semboller" }
];
const SKIN_TONE_MODIFIERS = ["", "🏻", "🏼", "🏽", "🏾", "🏿"];
const SKIN_TONE_BASES = new Set(
    CHAT_EMOJIS.filter(item => item.skin_tones).map(item => Array.from(item.emoji)[0])
);

let activeEmojiCategory = "Smileys & Emotion";
let selectedSkinTone = 0;

function applyEmojiSkinTone(emoji, tone = selectedSkinTone) {
    if (!tone) return emoji;
    const modifier = SKIN_TONE_MODIFIERS[tone];
    return Array.from(emoji).map(character =>
        SKIN_TONE_BASES.has(character) ? character + modifier : character
    ).join("");
}

const EMOJI_SHORTCODES = new Map();
CHAT_EMOJIS.forEach((item) => {
    item.aliases.forEach((alias) => {
        EMOJI_SHORTCODES.set(alias, item.emoji);
        if (item.skin_tones) {
            for (let tone = 1; tone <= 5; tone++) {
                EMOJI_SHORTCODES.set(`${alias}_tone${tone}`, applyEmojiSkinTone(item.emoji, tone));
            }
        }
    });
});

function replaceEmojiShortcodes(value) {
    return value.replace(/:([a-z0-9_+-]+):/gi, (match, code) => {
        return EMOJI_SHORTCODES.get(code.toLowerCase()) || match;
    });
}

const emojiPickerButton = $("emojiPickerButton");
const emojiPicker = $("emojiPicker");
const emojiPickerSearch = $("emojiPickerSearch");
const emojiPickerGrid = $("emojiPickerGrid");
const emojiAutocomplete = $("emojiAutocomplete");
const emojiCategoryTabs = $("emojiCategoryTabs");
const emojiSkinTone = $("emojiSkinTone");
const chatInput = $("chatInput");
let savedChatSelection = { start: 0, end: 0 };

function rememberChatSelection() {
    if (!chatInput) return;
    savedChatSelection = {
        start: chatInput.selectionStart ?? chatInput.value.length,
        end: chatInput.selectionEnd ?? chatInput.value.length
    };
}

function setEmojiPickerOpen(isOpen) {
    emojiPicker.hidden = !isOpen;
    emojiPickerButton.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) emojiPickerSearch.focus();
}

function insertChatEmoji(emoji) {
    const start = Math.min(savedChatSelection.start, chatInput.value.length);
    const end = Math.min(savedChatSelection.end, chatInput.value.length);
    const nextValue = chatInput.value.slice(0, start) + emoji + chatInput.value.slice(end);
    const nextCursor = start + emoji.length;

    chatInput.value = nextValue;
    chatInput.focus();
    chatInput.setSelectionRange(nextCursor, nextCursor);
    rememberChatSelection();
    resizeChatInput();
    setEmojiPickerOpen(false);
}

function renderEmojiPicker(searchValue = emojiPickerSearch.value) {
    const term = searchValue.trim().toLocaleLowerCase().replace(/^:|:$/g, "");
    const isSearching = term.length > 0;
    const filtered = CHAT_EMOJIS.filter((item) => {
        if (!isSearching && item.category !== activeEmojiCategory) return false;
        const searchable = [item.emoji, item.name, ...item.aliases, ...item.tags]
            .join(" ").toLocaleLowerCase();
        return !term || searchable.includes(term);
    });

    emojiPickerGrid.replaceChildren();

    if (!filtered.length) {
        const empty = document.createElement("p");
        empty.className = "emoji-picker-empty";
        empty.textContent = "Eşleşen emoji bulunamadı.";
        emojiPickerGrid.appendChild(empty);
        return;
    }

    filtered.forEach((item) => {
        const emoji = applyEmojiSkinTone(item.emoji);
        const option = document.createElement("button");
        option.type = "button";
        option.className = "emoji-option";
        option.textContent = emoji;
        option.title = item.name || item.aliases[0] || emoji;
        option.setAttribute("aria-label", item.name || item.aliases[0] || emoji);
        option.addEventListener("click", () => insertChatEmoji(emoji));
        emojiPickerGrid.appendChild(option);
    });
}

function setActiveEmojiCategory(category) {
    if (!EMOJI_CATEGORIES.some(item => item.id === category)) return;
    activeEmojiCategory = category;
    emojiPickerSearch.value = "";
    emojiCategoryTabs.querySelectorAll("[data-emoji-category]").forEach((button) => {
        const active = button.dataset.emojiCategory === category;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
    });
    renderEmojiPicker("");
}

emojiCategoryTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-emoji-category]");
    if (tab) setActiveEmojiCategory(tab.dataset.emojiCategory);
});

emojiSkinTone.addEventListener("change", () => {
    selectedSkinTone = Number(emojiSkinTone.value) || 0;
    renderEmojiPicker();
});

renderEmojiPicker();

emojiPickerButton.addEventListener("pointerdown", rememberChatSelection);
emojiPickerButton.addEventListener("click", () => {
    setEmojiPickerOpen(emojiPicker.hidden);
});

emojiPickerSearch.addEventListener("input", () => {
    renderEmojiPicker(emojiPickerSearch.value);
});

document.addEventListener("click", (event) => {
    if (!event.target.closest(".emoji-picker-wrap") && !emojiPicker.hidden) {
        setEmojiPickerOpen(false);
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !emojiPicker.hidden) {
        setEmojiPickerOpen(false);
        emojiPickerButton.focus();
    }
});

let emojiAutocompleteItems = [];
let emojiAutocompleteIndex = 0;
let emojiAutocompleteRange = null;

function emojiAliasDistance(left, right) {
    if (Math.abs(left.length - right.length) > 2) return 3;

    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let row = 1; row <= left.length; row++) {
        const current = [row];
        for (let column = 1; column <= right.length; column++) {
            current[column] = Math.min(
                current[column - 1] + 1,
                previous[column] + 1,
                previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
            );
        }
        previous = current;
    }
    return previous[right.length];
}

function emojiMatchScore(item, query) {
    const aliases = item.aliases.map(alias => alias.toLowerCase());
    const name = item.name.toLowerCase();
    const tags = item.tags.map(tag => tag.toLowerCase());

    if (aliases.includes(query)) return 0;
    if (aliases.some(alias => alias.startsWith(query))) return 1;
    if (name.startsWith(query)) return 2;
    if (tags.some(tag => tag.startsWith(query))) return 3;
    if (aliases.some(alias => alias.includes(query))) return 4;
    if (name.includes(query) || tags.some(tag => tag.includes(query))) return 5;

    if (query.length >= 3) {
        const distance = Math.min(...aliases.map(alias => emojiAliasDistance(alias, query)));
        if (distance <= 2) return 6 + distance;
    }
    return 99;
}

function renderEmojiAutocomplete() {
    const cursor = chatInput.selectionStart ?? chatInput.value.length;
    const beforeCursor = chatInput.value.slice(0, cursor);
    const match = beforeCursor.match(/(^|\s):([a-z0-9_+-]{1,32})$/i);

    if (!match) {
        closeEmojiAutocomplete();
        return;
    }

    const query = match[2].toLowerCase();
    const prefixLength = match[1].length;
    const start = cursor - match[0].length + prefixLength;
    emojiAutocompleteRange = { start, end: cursor };

    emojiAutocompleteItems = CHAT_EMOJIS
        .map(item => ({ item, score: emojiMatchScore(item, query) }))
        .filter(result => result.score < 99)
        .sort((a, b) =>
            a.score - b.score ||
            a.item.aliases[0].length - b.item.aliases[0].length ||
            a.item.aliases[0].localeCompare(b.item.aliases[0])
        )
        .slice(0, 8)
        .map(result => result.item);

    emojiAutocomplete.replaceChildren();
    if (!emojiAutocompleteItems.length) {
        const empty = document.createElement("div");
        empty.className = "emoji-autocomplete-empty";
        empty.textContent = "Eşleşen emoji bulunamadı.";
        emojiAutocomplete.appendChild(empty);
        emojiAutocomplete.hidden = false;
        emojiAutocompleteIndex = -1;
        return;
    }

    emojiAutocompleteIndex = 0;
    emojiAutocompleteItems.forEach((item, index) => {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "emoji-autocomplete-option";
        option.classList.toggle("active", index === emojiAutocompleteIndex);
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(index === emojiAutocompleteIndex));

        const symbol = document.createElement("span");
        symbol.className = "emoji-autocomplete-symbol";
        symbol.textContent = applyEmojiSkinTone(item.emoji);

        const copy = document.createElement("span");
        copy.className = "emoji-autocomplete-copy";

        const code = document.createElement("span");
        code.className = "emoji-autocomplete-code";
        code.textContent = `:${item.aliases[0]}:`;

        const name = document.createElement("span");
        name.className = "emoji-autocomplete-name";
        name.textContent = item.name;

        copy.append(code, name);
        option.append(symbol, copy);
        option.addEventListener("pointerdown", event => event.preventDefault());
        option.addEventListener("click", () => chooseEmojiAutocomplete(index));
        emojiAutocomplete.appendChild(option);
    });

    emojiAutocomplete.hidden = false;
}

function closeEmojiAutocomplete() {
    emojiAutocomplete.hidden = true;
    emojiAutocompleteItems = [];
    emojiAutocompleteRange = null;
    emojiAutocompleteIndex = 0;
}

function updateEmojiAutocompleteSelection() {
    const options = emojiAutocomplete.querySelectorAll(".emoji-autocomplete-option");
    options.forEach((option, index) => {
        const active = index === emojiAutocompleteIndex;
        option.classList.toggle("active", active);
        option.setAttribute("aria-selected", String(active));
    });
    options[emojiAutocompleteIndex]?.scrollIntoView({ block: "nearest" });
}

function chooseEmojiAutocomplete(index = emojiAutocompleteIndex) {
    const item = emojiAutocompleteItems[index];
    if (!item || !emojiAutocompleteRange) return false;

    const emoji = applyEmojiSkinTone(item.emoji);
    chatInput.setRangeText(
        emoji,
        emojiAutocompleteRange.start,
        emojiAutocompleteRange.end,
        "end"
    );
    closeEmojiAutocomplete();
    chatInput.focus();
    rememberChatSelection();
    resizeChatInput();
    return true;
}

function handleEmojiAutocompleteKeydown(event) {
    if (emojiAutocomplete.hidden) return false;

    if (event.key === "Escape") {
        event.preventDefault();
        closeEmojiAutocomplete();
        return true;
    }

    if (!emojiAutocompleteItems.length) return false;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        emojiAutocompleteIndex =
            (emojiAutocompleteIndex + direction + emojiAutocompleteItems.length) %
            emojiAutocompleteItems.length;
        updateEmojiAutocompleteSelection();
        return true;
    }

    if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        chooseEmojiAutocomplete();
        return true;
    }

    return false;
}

function handleChatInput() {
    const originalValue = chatInput.value;
    const cursor = chatInput.selectionStart ?? originalValue.length;
    const convertedBeforeCursor = replaceEmojiShortcodes(originalValue.slice(0, cursor));
    const convertedValue = replaceEmojiShortcodes(originalValue);

    if (convertedValue !== originalValue) {
        chatInput.value = convertedValue;
        const nextCursor = convertedBeforeCursor.length;
        chatInput.setSelectionRange(nextCursor, nextCursor);
        closeEmojiAutocomplete();
    } else {
        renderEmojiAutocomplete();
    }

    rememberChatSelection();
    resizeChatInput();
}

chatInput.addEventListener("click", () => {
    rememberChatSelection();
    renderEmojiAutocomplete();
});
chatInput.addEventListener("keyup", () => {
    rememberChatSelection();
    renderEmojiAutocomplete();
});
chatInput.addEventListener("select", () => {
    rememberChatSelection();
    renderEmojiAutocomplete();
});
chatInput.addEventListener("input", handleChatInput);

// SEND MESSAGE

$("chatForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!currentUser || !activeRoomId) {
        showChatStatus("Önce bir odaya katılmalısın.");
        return;
    }

    const input = $("chatInput");
    const button = $("chatSendButton");
    const text = replaceEmojiShortcodes(input.value.trim());

    if (!text) return;

    if (text.length > 2000) {
        showChatStatus("Mesaj en fazla 2.000 karakter olabilir.");
        return;
    }

    button.disabled = true;
    showChatStatus("");

    try {
        await addDoc(
            collection(db, "rooms", activeRoomId, "messages"),
            {
                text,
                senderId: currentUser.uid,
                senderName: currentUsername || "Kullanıcı",
                senderAvatarId: currentAvatarId || DEFAULT_AVATAR_ID,
                createdAt: serverTimestamp()
            }
        );

        input.value = "";
        resizeChatInput();
        showChatStatus("");
        input.focus();
    } catch (error) {
        console.error("CACA message send failed:", error);
        showChatStatus(
            error.code === "permission-denied"
                ? "Mesaj gönderme izni yok. Firestore Rules mesaj yazma kuralını kontrol et."
                : "Mesaj gönderilemedi: " + (error.message || "Bilinmeyen hata")
        );
    } finally {
        button.disabled = false;
    }
});

$("chatInput").addEventListener("keydown", (event) => {
    if (handleEmojiAutocompleteKeydown(event)) return;

    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        $("chatForm").requestSubmit();
    }
});

// Automatically grow the composer as text wraps. Recalculate when
// the chat panel width changes so resizing the desktop window never
// leaves the textarea at a stale height.
const CHAT_INPUT_MAX_HEIGHT = 130;

function resizeChatInput() {
    const input = $("chatInput");
    if (!input) return;

    input.style.height = "auto";

    const fullHeight = input.scrollHeight;
    const nextHeight = Math.min(fullHeight, CHAT_INPUT_MAX_HEIGHT);

    input.style.height = nextHeight + "px";
    input.style.overflowY = fullHeight > CHAT_INPUT_MAX_HEIGHT
        ? "auto"
        : "hidden";
}

// Input resizing is handled together with shortcode conversion in handleChatInput().

window.addEventListener("resize", resizeChatInput);

let chatPanelResizeObserver = null;

if ("ResizeObserver" in window) {
    const chatPanel = document.querySelector(".chat-panel");
    if (chatPanel) {
        let previousWidth = 0;

        chatPanelResizeObserver = new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width || 0;

            if (Math.abs(width - previousWidth) > 1) {
                previousWidth = width;
                resizeChatInput();
            }
        });

        chatPanelResizeObserver.observe(chatPanel);
    }
}

function setMembersPanelOpen(isOpen) {
    const layout = $("roomChatLayout");
    const toggle = $("membersToggleButton");

    layout.classList.toggle("members-collapsed", !isOpen);
    toggle.setAttribute("aria-expanded", String(isOpen));
    toggle.innerHTML = isOpen
        ? 'Üyeler <span aria-hidden="true">▥</span>'
        : 'Üyeleri göster <span aria-hidden="true">▥</span>';
}

$("membersToggleButton").addEventListener("click", () => {
    const isOpen = $("membersToggleButton").getAttribute("aria-expanded") === "true";
    setMembersPanelOpen(!isOpen);
});

$("closeMembersButton").addEventListener("click", () => {
    setMembersPanelOpen(false);
});


// Keep the room module's current display name in sync with settings.

document.addEventListener("caca:nickname-changed", (event) => {
    if (typeof event.detail?.nickname === "string") {
        currentUsername = event.detail.nickname;
        if (currentUser) publicProfileCache.delete(currentUser.uid);

        if (activeRoomId) {
            listenToMessages(activeRoomId);
        }
    }
});

document.addEventListener("caca:avatar-changed", (event) => {
    const avatarId = event.detail?.avatarId;
    if (!AVATARS[avatarId]) return;

    currentAvatarId = avatarId;
    currentAvatarData = event.detail?.avatarData || null;
    if (currentUser) publicProfileCache.delete(currentUser.uid);

    // The live profile listeners already refresh the member list and chat rows.
    // Calling listenToMembers() here would also stop the game and prank listeners.
});

// CREATE ROOM

$("createRoomForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!currentUser) return;

    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');

    const name = $("newRoomName").value.trim();

    if (name.length < 2 || name.length > 30) {
        showRoomMessage("Oda adı 2-30 karakter arasında olmalı.");
        return;
    }

    button.disabled = true;
    button.textContent = "Oluşturuluyor...";

    try {
        const roomRef = doc(collection(db, "rooms"));
        const code = generateRoomCode();

        const batch = writeBatch(db);

        // Main room
        batch.set(roomRef, {
            name: name,
            ownerId: currentUser.uid,
            inviteCode: code,
            createdAt: serverTimestamp()
        });

        // Invite code
        batch.set(doc(db, "roomInvites", code), {
            roomId: roomRef.id,
            roomName: name,
            createdAt: serverTimestamp()
        });

        // Owner membership
        batch.set(
            doc(db, "rooms", roomRef.id, "members", currentUser.uid),
            {
                username: currentUsername,
                role: "owner",
                joinedAt: serverTimestamp()
            }
        );

        // User's room list
        batch.set(
            doc(db, "users", currentUser.uid, "rooms", roomRef.id),
            {
                name: name,
                role: "owner",
                joinedAt: serverTimestamp()
            }
        );

        await batch.commit();

        form.reset();

        showRoomMessage("Odan başarıyla oluşturuldu!", true);

        await loadRooms();
        await openRoom(roomRef.id);

    } catch (error) {
        showRoomMessage(showError(error));

    } finally {
        button.disabled = false;
        button.textContent = "Oda oluştur";
    }
});

// JOIN ROOM

$("joinRoomForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!currentUser) return;

    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');

    const code = $("roomInviteCode").value.trim().toUpperCase();

    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) {
        showRoomMessage("Davet kodu 8 karakter olmalı.");
        return;
    }

    button.disabled = true;
    button.textContent = "Katılınıyor...";

    try {
        const inviteSnapshot = await getDoc(
            doc(db, "roomInvites", code)
        );

        if (!inviteSnapshot.exists()) {
            throw new Error("Bu davet koduyla bir oda bulunamadı.");
        }

        const invite = inviteSnapshot.data();
        const roomId = invite.roomId;

        const banSnapshot = await getDoc(
            doc(db, "rooms", roomId, "bans", currentUser.uid)
        );

        if (banSnapshot.exists()) {
            throw new Error(
                "Bu odadan banlandın. Oda sahibi banını kaldırana kadar tekrar katılamazsın."
            );
        }

        const ownRoomRef = doc(
            db,
            "users",
            currentUser.uid,
            "rooms",
            roomId
        );

        const existingRoom = await getDoc(ownRoomRef);

        if (existingRoom.exists()) {
            throw new Error("Bu odaya zaten katılmışsın.");
        }

        const batch = writeBatch(db);

        // Add member to room
        batch.set(
            doc(db, "rooms", roomId, "members", currentUser.uid),
            {
                username: currentUsername,
                role: "member",
                inviteCodeUsed: code,
                joinedAt: serverTimestamp()
            }
        );

        // Add room to user's list
        batch.set(ownRoomRef, {
            name: invite.roomName,
            role: "member",
            joinedAt: serverTimestamp()
        });

        await batch.commit();

        form.reset();

        showRoomMessage("Odaya başarıyla katıldın!", true);

        await loadRooms();
        await openRoom(roomId);

    } catch (error) {
        showRoomMessage(showError(error));

    } finally {
        button.disabled = false;
        button.textContent = "Odaya katıl";
    }
});

// ROOM ADMIN ROLES

function getAdminExpiryMs(member) {
    if (!member || member.adminExpiresAt == null) return null;
    const expiry = typeof member.adminExpiresAt.toDate === "function"
        ? member.adminExpiresAt.toDate()
        : new Date(member.adminExpiresAt);
    return Number.isFinite(expiry.getTime()) ? expiry.getTime() : Number.NaN;
}

function isActiveRoomAdmin(member) {
    if (!member || member.role !== "admin") return false;
    const expiryMs = getAdminExpiryMs(member);
    return expiryMs === null || (Number.isFinite(expiryMs) && expiryMs > Date.now());
}

function clearCurrentAdminExpiryTimer() {
    if (currentAdminExpiryTimer) {
        clearTimeout(currentAdminExpiryTimer);
        currentAdminExpiryTimer = null;
    }
}

function syncCurrentAdminExpiry(roomId) {
    clearCurrentAdminExpiryTimer();
    const member = currentRoomMemberRecord;
    if (
        !member ||
        member.id !== currentUser?.uid ||
        member.role !== "admin"
    ) return;

    const expiryMs = getAdminExpiryMs(member);
    if (expiryMs === null || !Number.isFinite(expiryMs)) return; // No valid expiry to schedule.

    const runDemotion = async () => {
        currentAdminExpiryTimer = null;
        if (activeRoomId !== roomId || currentUser?.uid !== member.id) return;

        const latest = currentRoomMemberRecord;
        if (
            !latest ||
            latest.role !== "admin" ||
            getAdminExpiryMs(latest) !== expiryMs
        ) return; // Permission may have been renewed or changed.

        // Small buffer avoids a client/server clock boundary race.
        if (Date.now() < expiryMs + 1500) {
            currentAdminExpiryTimer = setTimeout(
                runDemotion,
                Math.min(Math.max(expiryMs + 1500 - Date.now(), 500), 2147000000)
            );
            return;
        }

        try {
            await updateDoc(doc(db, "rooms", roomId, "members", member.id), {
                role: "member",
                adminExpiresAt: null,
                adminGrantedAt: null,
                adminGrantedBy: null
            });
            console.info("CACA admin permission expired and was removed:", member.id, roomId);
        } catch (error) {
            // Security Rules also stop expired admins from using admin actions.
            // If the cleanup write fails, the owner-side cleanup will retry when available.
            console.warn("CACA expired admin self-demotion failed:", member.id, error);
        }
    };

    const initialDelay = Math.max(500, Math.min(expiryMs + 1500 - Date.now(), 2147000000));
    currentAdminExpiryTimer = setTimeout(runDemotion, initialDelay);
}

function cleanupExpiredRoomAdminsForOwner(roomId, members) {
    if (activeRoomOwnerId !== currentUser?.uid || activeRoomId !== roomId) return;

    const expired = members.filter((member) =>
        member.id !== activeRoomOwnerId &&
        member.role === "admin" &&
        getAdminExpiryMs(member) !== null &&
        (!Number.isFinite(getAdminExpiryMs(member)) || getAdminExpiryMs(member) <= Date.now())
    );
    if (!expired.length) return;

    const pendingIds = expired
        .map((member) => member.id)
        .filter((userId) => !expiredAdminCleanupInProgress.has(`${roomId}:${userId}`));
    if (!pendingIds.length) return;

    const batches = [];
    for (let index = 0; index < pendingIds.length; index += 450) {
        const batch = writeBatch(db);
        pendingIds.slice(index, index + 450).forEach((userId) => {
            expiredAdminCleanupInProgress.add(`${roomId}:${userId}`);
            batch.update(doc(db, "rooms", roomId, "members", userId), {
                role: "member",
                adminExpiresAt: null,
                adminGrantedAt: null,
                adminGrantedBy: null
            });
        });
        batches.push(batch.commit());
    }

    Promise.all(batches)
        .then(() => {
            console.info("CACA expired room admin records cleaned:", pendingIds.length, roomId);
        })
        .catch((error) => {
            console.warn("CACA owner-side expired admin cleanup failed:", roomId, error);
        })
        .finally(() => {
            pendingIds.forEach((userId) =>
                expiredAdminCleanupInProgress.delete(`${roomId}:${userId}`)
            );
        });
}

function clearOwnerAdminExpiryTimer() {
    if (ownerAdminExpiryTimer) {
        clearTimeout(ownerAdminExpiryTimer);
        ownerAdminExpiryTimer = null;
    }
}

function scheduleOwnerAdminExpiryCleanup(roomId, members) {
    clearOwnerAdminExpiryTimer();
    if (activeRoomId !== roomId || activeRoomOwnerId !== currentUser?.uid) return;

    const now = Date.now();
    const nextExpiry = members
        .filter((member) => member.id !== activeRoomOwnerId && member.role === "admin")
        .map(getAdminExpiryMs)
        .filter((expiryMs) => Number.isFinite(expiryMs) && expiryMs > now)
        .sort((a, b) => a - b)[0];

    if (nextExpiry === undefined) return;

    const delay = Math.max(500, Math.min(nextExpiry + 1500 - now, 2147000000));
    ownerAdminExpiryTimer = setTimeout(async () => {
        ownerAdminExpiryTimer = null;
        if (activeRoomId !== roomId || activeRoomOwnerId !== currentUser?.uid) return;

        try {
            const snapshot = await getDocs(collection(db, "rooms", roomId, "members"));
            if (activeRoomId !== roomId || activeRoomOwnerId !== currentUser?.uid) return;

            const latestMembers = snapshot.docs.map((memberDoc) => ({
                id: memberDoc.id,
                ...memberDoc.data()
            }));
            cleanupExpiredRoomAdminsForOwner(roomId, latestMembers);
            scheduleOwnerAdminExpiryCleanup(roomId, latestMembers);
        } catch (error) {
            console.warn("CACA owner admin expiry check failed:", roomId, error);
            // Retry a failed read while the owner remains in this room.
            if (activeRoomId === roomId && activeRoomOwnerId === currentUser?.uid) {
                ownerAdminExpiryTimer = setTimeout(
                    () => scheduleOwnerAdminExpiryCleanup(roomId, members),
                    5000
                );
            }
        }
    }, delay);
}

function isCurrentUserRoomAdmin() {
    return isActiveRoomAdmin(currentRoomMemberRecord);
}

function canCurrentUserKickMembers() {
    return Boolean(
        currentUser &&
        (activeRoomOwnerId === currentUser.uid || isCurrentUserRoomAdmin())
    );
}

function formatAdminExpiry(value) {
    if (!value) return "Kalıcı yönetici";
    const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
    if (!Number.isFinite(date.getTime())) return "Süre bilgisi yok";
    return `Bitiş: ${new Intl.DateTimeFormat("tr-TR", {
        dateStyle: "short",
        timeStyle: "short"
    }).format(date)}`;
}

// Accept Turkish and common English duration units. "s" means hour;
// "sn" means second, as requested. Compound values such as "1s 30dk" add up.
function parseAdminDuration(input) {
    const source = String(input || "").toLowerCase().replace(/\u0307/g, "").trim();
    if (!source) return null;

    const unitPattern = "(?:milisaniye(?:ler)?|milliseconds?|msecs?|ms|saniye(?:ler)?|seconds?|secs?|sn|dakika(?:lar)?|minutes?|mins?|dk|saat(?:ler)?|hours?|hrs?|sa|gün(?:ler)?|gun(?:ler)?|days?|hafta(?:lar)?|weeks?|ay(?:lar)?|months?|mos?|mo|mth|mths|yıl(?:lar)?|yil(?:lar)?|years?|yrs?|yr|hf|g|m|h|s|d|w|y)";
    const tokenPattern = new RegExp("(\\d+(?:[.,]\\d+)?)\\s*(" + unitPattern + ")", "iy");

    const multipliers = {
        milliseconds: 1,
        seconds: 1000,
        minutes: 60 * 1000,
        hours: 60 * 60 * 1000,
        days: 24 * 60 * 60 * 1000,
        weeks: 7 * 24 * 60 * 60 * 1000,
        months: 30 * 24 * 60 * 60 * 1000,
        years: 365 * 24 * 60 * 60 * 1000
    };

    let position = 0;
    let totalMs = 0;
    let tokenCount = 0;

    while (position < source.length) {
        while (position < source.length && /[\s+;,]/.test(source[position])) position++;
        if (position >= source.length) break;

        tokenPattern.lastIndex = position;
        const match = tokenPattern.exec(source);
        if (!match) return null;

        const amount = Number(match[1].replace(",", "."));
        if (!Number.isFinite(amount) || amount <= 0) return null;

        const unit = match[2];
        let category;
        if (/^(?:ms|milisaniye|milliseconds?|msecs?)/.test(unit)) {
            category = "milliseconds";
        } else if (/^(?:sn|saniye|seconds?|secs?)/.test(unit)) {
            category = "seconds";
        } else if (/^(?:dk|dakika|minutes?|mins?|m)$/.test(unit)) {
            category = "minutes";
        } else if (/^(?:saat|sa|hours?|hrs?|h|s)$/.test(unit)) {
            category = "hours";
        } else if (/^(?:gün|gun|days?|d|g)/.test(unit)) {
            category = "days";
        } else if (/^(?:hafta|weeks?|w|hf)/.test(unit)) {
            category = "weeks";
        } else if (/^(?:ay|months?|mos?|mo|mth|mths)/.test(unit)) {
            category = "months";
        } else if (/^(?:yıl|yil|years?|yrs?|yr|y)/.test(unit)) {
            category = "years";
        } else {
            return null;
        }

        totalMs += amount * multipliers[category];
        if (!Number.isFinite(totalMs) || totalMs > Number.MAX_SAFE_INTEGER) return null;
        tokenCount++;
        position = tokenPattern.lastIndex;
    }

    if (!tokenCount) return null;
    const roundedMs = Math.round(totalMs);
    return Number.isSafeInteger(roundedMs) && roundedMs > 0 ? roundedMs : null;
}

function syncAdminDurationInput() {
    const isCustom = $("adminDurationSelect").value === "custom";
    $("adminCustomDurationInput").hidden = !isCustom;
    if (!isCustom) $("adminCustomDurationInput").value = "";
    $("adminCustomDurationInput").setAttribute("aria-hidden", String(!isCustom));
}

$("adminDurationSelect").addEventListener("change", () => {
    syncAdminDurationInput();
    if ($("adminDurationSelect").value === "custom") {
        $("adminCustomDurationInput").focus();
    }
});

async function grantRoomAdmin() {
    if (!currentUser || activeRoomOwnerId !== currentUser.uid || !activeRoomId) return;

    const targetId = $("adminTargetSelect").value;
    const durationValue = $("adminDurationSelect").value;
    const customDurationText = $("adminCustomDurationInput").value;
    const customDurationMs = durationValue === "custom"
        ? parseAdminDuration(customDurationText)
        : null;

    if (!targetId) {
        $("adminManagementStatus").textContent = "Önce bir üye seç.";
        return;
    }
    if (targetId === activeRoomOwnerId) {
        $("adminManagementStatus").textContent = "Oda sahibi zaten en yüksek yetkiye sahip.";
        return;
    }
    if (durationValue === "custom" && customDurationMs === null) {
        $("adminManagementStatus").textContent =
            "Süreyi tanınan birimlerle yaz. Örnek: 1sn, 5 saniye, 1dk, 2saat veya 1s 30dk.";
        $("adminCustomDurationInput").focus();
        return;
    }

    const button = $("grantAdminButton");
    button.disabled = true;
    $("adminManagementStatus").textContent = "Yetki veriliyor...";

    try {
        let adminExpiresAt = null;
        if (durationValue !== "permanent") {
            const durationMs = durationValue === "custom"
                ? customDurationMs
                : Number(durationValue);
            const expiryDate = new Date(Date.now() + durationMs);
            if (
                !Number.isFinite(durationMs) ||
                durationMs <= 0 ||
                !Number.isFinite(expiryDate.getTime()) ||
                expiryDate.getUTCFullYear() > 9999
            ) {
                throw new Error("Süre çok büyük veya geçersiz. Daha kısa bir süre yaz.");
            }
            adminExpiresAt = Timestamp.fromDate(expiryDate);
        }

        await updateDoc(
            doc(db, "rooms", activeRoomId, "members", targetId),
            {
                role: "admin",
                adminExpiresAt,
                adminGrantedAt: serverTimestamp(),
                adminGrantedBy: currentUser.uid
            }
        );

        $("adminManagementStatus").textContent = durationValue === "permanent"
            ? "Kalıcı yönetici yetkisi verildi."
            : "Süreli yönetici yetkisi verildi.";
    } catch (error) {
        console.error("CACA admin grant failed:", error);
        $("adminManagementStatus").textContent =
            error.code === "permission-denied"
                ? "Yetki verilemedi. Firestore Rules içindeki yönetici atama iznini yayımla."
                : "Yetki verilemedi: " + (error.message || "Bilinmeyen hata");
    } finally {
        button.disabled = false;
    }
}

async function revokeRoomAdmin(userId, username) {
    if (!currentUser || activeRoomOwnerId !== currentUser.uid || !activeRoomId) return;
    if (!window.confirm(`${username} kullanıcısının yönetici yetkisini kaldırmak istiyor musun?`)) return;

    try {
        await updateDoc(
            doc(db, "rooms", activeRoomId, "members", userId),
            {
                role: "member",
                adminExpiresAt: null,
                adminGrantedAt: null,
                adminGrantedBy: null
            }
        );
        $("adminManagementStatus").textContent = `${username} artık normal üye.`;
    } catch (error) {
        console.error("CACA admin revoke failed:", error);
        $("adminManagementStatus").textContent =
            error.code === "permission-denied"
                ? "Yetki kaldırılamadı. Firestore Rules içindeki yönetici rolü iznini kontrol et."
                : "Yetki kaldırılamadı: " + (error.message || "Bilinmeyen hata");
    }
}

function renderAdminManagement(members) {
    if (activeRoomOwnerId !== currentUser?.uid) return;

    const select = $("adminTargetSelect");
    const previousValue = select.value;
    select.replaceChildren();

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Üye seç...";
    select.appendChild(placeholder);

    members
        .filter(member => member.id !== activeRoomOwnerId)
        .sort((a, b) => (a.displayNickname || "").localeCompare(b.displayNickname || "", "tr"))
        .forEach(member => {
            const option = document.createElement("option");
            option.value = member.id;
            option.textContent = isActiveRoomAdmin(member)
                ? `${member.displayNickname} · Yönetici`
                : member.displayNickname;
            select.appendChild(option);
        });

    if (previousValue && Array.from(select.options).some(option => option.value === previousValue)) {
        select.value = previousValue;
    }

    const list = $("roomAdminsList");
    list.replaceChildren();

    const admins = members
        .filter(member => member.id !== activeRoomOwnerId && member.role === "admin")
        .sort((a, b) => (a.displayNickname || "").localeCompare(b.displayNickname || "", "tr"));

    if (!admins.length) {
        const empty = document.createElement("p");
        empty.className = "member-search-empty";
        empty.textContent = "Henüz atanmış yönetici yok.";
        list.appendChild(empty);
        return;
    }

    admins.forEach(member => {
        const item = document.createElement("div");
        item.className = "room-admin-item";

        const avatar = document.createElement("div");
        avatar.className = "member-avatar";
        setAvatarElement(avatar, member.avatarId, member.avatarData);

        const info = document.createElement("div");
        info.className = "room-admin-info";

        const name = document.createElement("strong");
        name.textContent = member.displayNickname;

        const expiry = document.createElement("span");
        const active = isActiveRoomAdmin(member);
        expiry.textContent = active
            ? formatAdminExpiry(member.adminExpiresAt)
            : "Süresi doldu · normal üye";
        expiry.classList.toggle("admin-expired-label", !active);

        info.append(name, expiry);

        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.className = "admin-revoke-button";
        revoke.textContent = "Yetkiyi kaldır";
        revoke.addEventListener("click", () =>
            revokeRoomAdmin(member.id, member.displayNickname)
        );

        item.append(avatar, info, revoke);
        list.appendChild(item);
    });
}

$("grantAdminButton").addEventListener("click", grantRoomAdmin);

// REAL-TIME MEMBER LIST

function listenToMembers(roomId, ownerId) {

    // Stop previous room listener
    stopMemberListener();

    activeRoomId = roomId;
    activeRoomOwnerId = ownerId;

    const membersReference = collection(
        db,
        "rooms",
        roomId,
        "members"
    );

    // This listener runs once immediately and again whenever
    // a member is added, changed or removed.
    unsubscribeMembers = onSnapshot(
        membersReference,

        async (snapshot) => {

            // Ignore events from a room that is no longer open.
            if (activeRoomId !== roomId) return;

            const renderVersion = ++memberRenderVersion;
            const membersList = $("membersList");
            const heading = $("membersHeading");
            const ownMemberSnapshot = snapshot.docs.find(memberDoc => memberDoc.id === currentUser.uid);
            currentRoomMemberRecord = ownMemberSnapshot
                ? { id: ownMemberSnapshot.id, ...ownMemberSnapshot.data() }
                : null;
            syncCurrentAdminExpiry(roomId);
            if (activeRoomOwnerId === currentUser?.uid) {
                scheduleOwnerAdminExpiryCleanup(
                    roomId,
                    snapshot.docs.map((memberDoc) => ({
                        id: memberDoc.id,
                        ...memberDoc.data()
                    }))
                );
            }

            const isOwnerViewing = activeRoomOwnerId === currentUser?.uid;
            const canAccessAdminPanel =
                isOwnerViewing || isCurrentUserRoomAdmin();
            $("roomManagementButton").hidden = !isOwnerViewing;
            $("adminPanelButton").hidden = !canAccessAdminPanel;
            $("adminAssignmentSection").hidden = !isOwnerViewing;
            $("bannedSection").hidden = !isOwnerViewing;
            $("clearChatManagementSection").hidden = !isOwnerViewing;
            $("jumpscareOpenButton").hidden = !canAccessAdminPanel;

            // Keep a real-time listener on every current member's public
            // profile. Profile changes then reach everyone in this room live.
            const currentMemberIds = new Set(
                snapshot.docs.map((memberDoc) => memberDoc.id)
            );

            for (const [profileUserId, unsubscribe] of liveProfileUnsubscribers) {
                if (!currentMemberIds.has(profileUserId)) {
                    unsubscribe();
                    liveProfileUnsubscribers.delete(profileUserId);
                    publicProfileCache.delete(profileUserId);
                }
            }

            for (const memberDoc of snapshot.docs) {
                const profileUserId = memberDoc.id;
                if (liveProfileUnsubscribers.has(profileUserId)) continue;

                const unsubscribe = onSnapshot(
                    doc(db, "users", profileUserId),
                    (profileSnapshot) => {
                        const profile = profileSnapshot.exists()
                            ? profileSnapshot.data()
                            : null;

                        publicProfileCache.set(
                            profileUserId,
                            Promise.resolve(profile)
                        );

                        if (activeRoomId === roomId) {
                            updateLiveProfileUI(profileUserId, profile);
                        }
                    },
                    (error) => {
                        console.warn(
                            "CACA: Live profile listener failed:",
                            profileUserId,
                            error
                        );
                    }
                );

                liveProfileUnsubscribers.set(profileUserId, unsubscribe);
            }

            // Do not reuse stale profile reads when a room member snapshot
            // changes; the following reads are refreshed for this render.
            for (const profileUserId of currentMemberIds) {
                publicProfileCache.delete(profileUserId);
            }

            membersList.replaceChildren();

            heading.textContent = "Üyeler";
            $("membersCount").textContent = snapshot.size;

            if (snapshot.empty) {
                const empty = document.createElement("p");
                empty.className = "empty-rooms";
                empty.textContent = "Bu odada henüz üye yok.";

                activeRoomMembers = [];
                renderJumpscareTargets();
                renderGameCenter();
                membersList.appendChild(empty);
                return;
            }

            const members = await Promise.all(
                snapshot.docs.map(async (memberDoc) => {
                    const member = {
                        id: memberDoc.id,
                        ...memberDoc.data()
                    };

                    const names = await getAccountDisplayNames(
                        member.id,
                        member.username || "Bilinmeyen kullanıcı"
                    );

                    return { ...member, ...names };
                })
            );

            // A newer snapshot may have arrived while profile reads were running.
            if (activeRoomId !== roomId || renderVersion !== memberRenderVersion) {
                return;
            }

            activeRoomMembers = members;
            cleanupExpiredRoomAdminsForOwner(roomId, members);
            renderJumpscareTargets();
            renderGameCenter();

            // Group the room owner separately; keep all other members alphabetical.
            members.sort((a, b) => {
                if (a.id === ownerId) return -1;
                if (b.id === ownerId) return 1;

                return (a.displayNickname || "").localeCompare(
                    b.displayNickname || "",
                    "tr"
                );
            });

            const ownerMembers = members.filter(member =>
                member.id === ownerId || member.role === "owner"
            );
            const adminMembers = members.filter(member =>
                member.id !== ownerId && isActiveRoomAdmin(member)
            );
            const regularMembers = members.filter(member =>
                member.id !== ownerId && member.role !== "owner" && !isActiveRoomAdmin(member)
            );

            renderAdminManagement(members);

            function createMemberGroup(label, groupMembers) {
                if (!groupMembers.length) return null;

                const group = document.createElement("section");
                group.className = "member-group";

                const groupHeading = document.createElement("div");
                groupHeading.className = "member-group-heading";

                const groupLabel = document.createElement("span");
                groupLabel.textContent = label;

                const groupCount = document.createElement("strong");
                groupCount.textContent = groupMembers.length;

                groupHeading.append(groupLabel, groupCount);

                const groupItems = document.createElement("div");
                groupItems.className = "member-group-items";

                group.append(groupHeading, groupItems);
                membersList.appendChild(group);

                return groupItems;
            }

            const ownerGroup = createMemberGroup("ODA SAHİBİ", ownerMembers);
            const adminGroup = createMemberGroup("YÖNETİCİLER", adminMembers);
            const regularGroup = createMemberGroup("ÜYELER", regularMembers);

            for (const member of members) {
                const isOwner = member.id === ownerId || member.role === "owner";
                const isAdmin = !isOwner && isActiveRoomAdmin(member);
                const isSelf = member.id === currentUser.uid;

                const item = document.createElement("div");
                item.className = "member-item";
                item.classList.toggle("owner", isOwner);
                item.classList.toggle("is-self", isSelf);
                item.dataset.userId = member.id;

                const avatar = document.createElement("div");
                avatar.className = "member-avatar";
                setAvatarElement(avatar, member.avatarId, member.avatarData);

                const info = document.createElement("div");
                info.className = "member-info";

                const nameLine = document.createElement("div");
                nameLine.className = "member-name-line";

                const nickname = document.createElement("strong");
                nickname.className = "member-display-name";
                nickname.textContent = member.displayNickname;

                nameLine.appendChild(nickname);

                if (isOwner) {
                    const ownerBadge = document.createElement("span");
                    ownerBadge.className = "member-badge owner-badge";
                    ownerBadge.textContent = "KURUCU";
                    nameLine.appendChild(ownerBadge);
                }

                if (isAdmin) {
                    const adminBadge = document.createElement("span");
                    adminBadge.className = "member-badge admin-badge";
                    adminBadge.textContent = "ADMIN";
                    nameLine.appendChild(adminBadge);
                }

                if (isSelf) {
                    const selfBadge = document.createElement("span");
                    selfBadge.className = "member-badge self-badge";
                    selfBadge.textContent = "SEN";
                    nameLine.appendChild(selfBadge);
                }

                const username = document.createElement("span");
                username.className = "member-account-username";

                const usernameDiffers =
                    member.accountUsername.trim().toLowerCase() !==
                    member.displayNickname.trim().toLowerCase();

                username.textContent = `@${member.accountUsername}`;
                username.hidden = !usernameDiffers;

                info.append(nameLine, username);
                item.append(avatar, info);

                const ownerIsViewing = currentUser.uid === activeRoomOwnerId;
                const viewerIsAdmin = isCurrentUserRoomAdmin();
                const canKickThisMember =
                    member.id !== activeRoomOwnerId &&
                    (ownerIsViewing || (viewerIsAdmin && !isAdmin));

                if (canKickThisMember) {
                    const actions = document.createElement("div");
                    actions.className = "member-actions";

                    const kickButton = document.createElement("button");
                    kickButton.type = "button";
                    kickButton.className = "member-action-button";
                    kickButton.textContent = "−";
                    kickButton.title = "Üyeyi odadan çıkar";
                    kickButton.setAttribute("aria-label", "Üyeyi odadan çıkar");
                    kickButton.addEventListener("click", () => {
                        manageMember(member, "kick");
                    });
                    actions.appendChild(kickButton);

                    if (ownerIsViewing) {
                        const banButton = document.createElement("button");
                        banButton.type = "button";
                        banButton.className = "member-action-button ban";
                        banButton.textContent = "⊘";
                        banButton.title = "Üyeyi banla";
                        banButton.setAttribute("aria-label", "Üyeyi banla");
                        banButton.addEventListener("click", () => {
                            manageMember(member, "ban");
                        });
                        actions.appendChild(banButton);
                    }

                    item.appendChild(actions);
                }

                const targetGroup = isOwner ? ownerGroup : (isAdmin ? adminGroup : regularGroup);
                targetGroup?.appendChild(item);
            }

            filterMemberList();

            console.log(
                `CACA: Room ${roomId} member list updated. Total: ${snapshot.size}`
            );
        },

        (error) => {
            console.error("CACA member listener failed:", error);

            if (activeRoomId === roomId) {
                showRoomMessage(
                    "Üye listesi canlı güncellenemedi: " + showError(error)
                );
            }
        }
    );

    // Watch this user's membership separately. A kick or ban removes this
    // document and immediately returns the affected user to the dashboard.
    unsubscribeMyMembership = onSnapshot(
        doc(db, "rooms", roomId, "members", currentUser.uid),
        async (membershipSnapshot) => {
            if (activeRoomId !== roomId || membershipSnapshot.exists() || isDeletingRoom) return;

            let isBanned = false;

            try {
                const banSnapshot = await getDoc(
                    doc(db, "rooms", roomId, "bans", currentUser.uid)
                );
                isBanned = banSnapshot.exists();
            } catch (error) {
                console.warn("CACA: Could not check ban status after removal.", error);
            }

            if (activeRoomId !== roomId) return;

            stopMemberListener();
            $("roomView").hidden = true;
            $("dashboardView").hidden = false;
            await loadRooms();

            showRoomMessage(
                isBanned
                    ? "Bu odadan banlandın. Oda sahibi banını kaldırana kadar tekrar katılamazsın."
                    : "Oda sahibi seni odadan çıkardı."
            );
        },
        (error) => {
            console.error("CACA membership listener failed:", error);
        }
    );

    if (activeRoomOwnerId === currentUser.uid) {
        listenToBannedMembers(roomId);
    }
}

// REAL-TIME BANNED MEMBERS (OWNER ONLY)

function listenToBannedMembers(roomId) {
    if (unsubscribeBanned) {
        unsubscribeBanned();
        unsubscribeBanned = null;
    }

    unsubscribeBanned = onSnapshot(
        collection(db, "rooms", roomId, "bans"),
        async (snapshot) => {
            if (activeRoomId !== roomId || activeRoomOwnerId !== currentUser?.uid) {
                return;
            }

            const renderVersion = ++bannedRenderVersion;
            const section = $("bannedSection");
            const list = $("bannedList");
            const heading = $("bannedHeading");

            section.hidden = false;
            list.replaceChildren();
            heading.textContent = `${snapshot.size} kişi`;

            if (snapshot.empty) {
                const empty = document.createElement("p");
                empty.className = "empty-rooms";
                empty.textContent = "Bu odada banlı kullanıcı yok.";
                list.appendChild(empty);
                return;
            }

            const bannedUsers = await Promise.all(
                snapshot.docs.map(async (banDoc) => {
                    const ban = banDoc.data();
                    const names = await getAccountDisplayNames(
                        banDoc.id,
                        ban.username || "Bilinmeyen kullanıcı"
                    );

                    return { id: banDoc.id, ban, ...names };
                })
            );

            if (activeRoomId !== roomId || renderVersion !== bannedRenderVersion) {
                return;
            }

            for (const bannedUser of bannedUsers) {
                const item = document.createElement("div");
                item.className = "banned-user-item";
                item.dataset.userId = bannedUser.id;

                const avatar = document.createElement("div");
                avatar.className = "member-avatar";
                setAvatarElement(avatar, bannedUser.avatarId, bannedUser.avatarData);

                const info = document.createElement("div");
                info.className = "member-info";

                const nickname = document.createElement("strong");
                nickname.className = "member-display-name";
                nickname.textContent = bannedUser.displayNickname;

                const username = document.createElement("span");
                username.className = "member-account-username";
                const usernameDiffers =
                    bannedUser.accountUsername.trim().toLowerCase() !==
                    bannedUser.displayNickname.trim().toLowerCase();
                username.textContent = usernameDiffers
                    ? `(${bannedUser.accountUsername})`
                    : "";
                username.hidden = !usernameDiffers;

                info.append(nickname, username);

                const button = document.createElement("button");
                button.type = "button";
                button.className = "unban-button";
                button.textContent = "Banı kaldır";
                button.addEventListener("click", () => {
                    unbanMember(
                        bannedUser.id,
                        bannedUser.displayNickname
                    );
                });

                item.append(avatar, info, button);
                list.appendChild(item);
            }
        },
        (error) => {
            console.error("CACA banned-members listener failed:", error);
            if (activeRoomId === roomId) {
                showRoomMessage("Banlı kullanıcılar yüklenemedi: " + showError(error));
            }
        }
    );
}

// OWNER ACTIONS: KICK / BAN

async function manageMember(member, action) {
    if (!currentUser || !activeRoomId || !canCurrentUserKickMembers()) {
        showModerationNotice(
            "Yetki gerekiyor",
            "Bu odada üye çıkarma işlemini yalnızca oda sahibi veya yetkili yönetici yapabilir.",
            "error"
        );
        return;
    }

    const ownerIsActing = activeRoomOwnerId === currentUser.uid;
    const adminIsActing = isCurrentUserRoomAdmin();

    if (action !== "kick" && action !== "ban") return;

    if (action === "ban" && !ownerIsActing) {
        showModerationNotice(
            "Ban yetkisi yok",
            "Yöneticiler kullanıcıları odadan çıkarabilir ancak banlayamaz. Ban yetkisi yalnızca oda sahibindedir.",
            "error"
        );
        return;
    }

    if (member.id === activeRoomOwnerId) {
        showModerationNotice(
            "İşlem yapılamadı",
            "Oda kurucusu odadan çıkarılamaz veya banlanamaz.",
            "error"
        );
        return;
    }

    if (adminIsActing && !ownerIsActing && isActiveRoomAdmin(member)) {
        showModerationNotice(
            "İşlem yapılamadı",
            "Bir yönetici başka bir aktif yöneticiyi odadan çıkaramaz. Bu işlemi yalnızca oda sahibi yapabilir.",
            "error"
        );
        return;
    }

    const actionText = action === "ban" ? "banlamak" : "odadan çıkarmak";
    const confirmed = window.confirm(
        `${member.username || "Bu kullanıcı"} kullanıcısını ${actionText} istiyor musun?`
    );

    if (!confirmed) return;

    try {
        const batch = writeBatch(db);
        const memberRef = doc(db, "rooms", activeRoomId, "members", member.id);
        const userRoomRef = doc(db, "users", member.id, "rooms", activeRoomId);

        if (action === "ban") {
            batch.set(
                doc(db, "rooms", activeRoomId, "bans", member.id),
                {
                    username: member.accountUsername || member.username || "Bilinmeyen kullanıcı",
                    bannedAt: serverTimestamp(),
                    bannedBy: currentUser.uid
                }
            );
        }

        const gameSessionRef = doc(db, "rooms", activeRoomId, "gameSessions", "active");
        const gameSessionSnapshot = await getDoc(gameSessionRef);
        if (gameSessionSnapshot.exists()) {
            const gameSession = gameSessionSnapshot.data();
            const participantFields = {};
            const players = Array.isArray(gameSession.playerIds) ? gameSession.playerIds : [];
            const matchPlayers = Array.isArray(gameSession.matchPlayerIds)
                ? gameSession.matchPlayerIds
                : (["playing", "results"].includes(gameSession.status) ? players : []);
            const spectators = Array.isArray(gameSession.spectatorIds) ? gameSession.spectatorIds : [];
            const remainingPlayers = players.filter((id) => id !== member.id);
            const hostWasKicked = gameSession.hostId === member.id;

            for (const field of ["playerIds", "readyIds", "matchPlayerIds", "spectatorIds", "nextRoundPlayerIds", "nextRoundReadyIds", "resultReturnIds"]) {
                const source = field === "matchPlayerIds" ? matchPlayers
                    : field === "spectatorIds" ? spectators
                    : gameSession[field];
                if (Array.isArray(source) && source.includes(member.id)) {
                    participantFields[field] = arrayRemove(member.id);
                }
            }

            if (gameSession.status === "starting" &&
                (players.includes(member.id) || hostWasKicked)) {
                participantFields.status = "lobby";
                participantFields.countdownEndsAt = null;
            }

            if (hostWasKicked) {
                if (remainingPlayers.length === 0) {
                    batch.delete(gameSessionRef);
                } else {
                    participantFields.playerIds = remainingPlayers;
                    participantFields.hostId = remainingPlayers[0];
                    batch.update(gameSessionRef, {
                        ...participantFields,
                        updatedAt: serverTimestamp()
                    });
                }
            } else if (Object.keys(participantFields).length) {
                batch.update(gameSessionRef, {
                    ...participantFields,
                    updatedAt: serverTimestamp()
                });
            }
        }

        batch.delete(memberRef);
        batch.delete(userRoomRef);
        batch.delete(doc(db, "rooms", activeRoomId, "prankInbox", member.id));
        await batch.commit();

        const targetName = member.displayNickname || member.username || "Bilinmeyen kullanıcı";
        const accountName = member.accountUsername && member.accountUsername !== targetName
            ? ` (@${member.accountUsername})`
            : "";
        const actorRole = ownerIsActing ? "Oda sahibi" : "Yönetici";
        const details = [
            `İşlemi yapan: ${currentUsername || "Sen"} — ${actorRole}`,
            `İşlem yapılan: ${targetName}${accountName}`,
            "",
            action === "ban"
                ? "Sonuç: Oda üyeliği kaldırıldı ve kullanıcı ban listesine eklendi. Oda sahibi banı kaldırana kadar bu odaya tekrar katılamaz."
                : "Sonuç: Oda üyeliği kaldırıldı. Kullanıcı banlanmadı."
        ].join("\n");

        showModerationNotice(
            action === "ban" ? "Kullanıcı banlandı" : "Kullanıcı odadan çıkarıldı",
            details,
            action === "ban" ? "ban" : "success"
        );
    } catch (error) {
        showModerationNotice("İşlem başarısız", showError(error), "error");
    }
}

// OWNER ACTION: UNBAN

async function unbanMember(userId, username) {
    if (!currentUser || !activeRoomId || activeRoomOwnerId !== currentUser.uid) {
        return;
    }

    if (!window.confirm(`${username} kullanıcısının banını kaldırmak istiyor musun?`)) {
        return;
    }

    try {
        await deleteDoc(doc(db, "rooms", activeRoomId, "bans", userId));
        showModerationNotice(
            "Ban kaldırıldı",
            `İşlem yapılan: ${username}\n\nSonuç: Kullanıcının ban kaydı silindi. Bu kullanıcı geçerli oda davetiyle yeniden katılabilir.`,
            "success"
        );
    } catch (error) {
        showModerationNotice("Ban kaldırılamadı", showError(error), "error");
    }
}

// OPEN ROOM

async function openRoom(roomId) {
    if (!currentUser) return;

    // Clicking the room that is already visible must not reread its documents
    // or recreate its realtime listeners.
    if (roomId === activeRoomId && !$("roomView").hidden) return;

    // Prevent rapid double-clicks from issuing duplicate Firestore reads.
    if (openingRoomId === roomId) return;

    const requestVersion = ++roomOpenRequestVersion;
    openingRoomId = roomId;

    try {
        isDeletingRoom = false;

        const banSnapshot = await getDoc(
            doc(db, "rooms", roomId, "bans", currentUser.uid)
        );
        if (requestVersion !== roomOpenRequestVersion) return;

        if (banSnapshot.exists()) {
            throw new Error(
                "Bu odadan banlandın. Oda sahibi banını kaldırana kadar tekrar katılamazsın."
            );
        }

        // Verify that this user belongs to the room.
        const membership = await getDoc(
            doc(db, "users", currentUser.uid, "rooms", roomId)
        );
        if (requestVersion !== roomOpenRequestVersion) return;

        if (!membership.exists()) {
            throw new Error("Bu odaya erişim iznin yok.");
        }

        const roomSnapshot = await getDoc(
            doc(db, "rooms", roomId)
        );
        if (requestVersion !== roomOpenRequestVersion) return;

        if (!roomSnapshot.exists()) {
            throw new Error("Oda bulunamadı.");
        }

        const room = roomSnapshot.data();

        $("activeRoomName").textContent = room.name;
        $("activeRoomCode").textContent = room.inviteCode;

        activeRoomCode = room.inviteCode;

        const isOwner = room.ownerId === currentUser.uid;
        $("bannedSection").hidden = !isOwner;
        $("roomManagementButton").hidden = true;
        $("adminPanelButton").hidden = true;
        $("jumpscareOpenButton").hidden = true;
        $("adminAssignmentSection").hidden = !isOwner;
        $("clearChatManagementSection").hidden = !isOwner;
        $("adminManagementStatus").textContent = "";
        $("trollManagementStatus").textContent = "";
        $("roomManagementPanel").hidden = true;
        $("adminPanel").hidden = true;
        $("jumpscarePanel").hidden = true;

        const leaveButton = $("leaveRoomButton");
        leaveButton.disabled = false;
        leaveButton.classList.toggle("room-delete-button", isOwner);
        leaveButton.textContent = isOwner ? "Odayı sil" : "Odadan çık";
        leaveButton.title = isOwner
            ? "Odayı, üyelikleri, davet kodunu ve ban kayıtlarını kalıcı olarak siler."
            : "Bu odadan ayrıl.";

        // Show room and close account settings before opening the chat.
        $("settingsView").hidden = true;
        $("dashboardView").hidden = true;
        $("roomView").hidden = false;

        // Highlight the selected room in the left-hand list.
        document.querySelectorAll(".room-list-item").forEach((button) => {
            button.classList.toggle("active", button.dataset.roomId === roomId);
        });

        // Open the member panel by default for a newly selected room.
        setMembersPanelOpen(true);

        // Start live member, chat and room-wide prank updates.
        listenToMembers(roomId, room.ownerId);
        listenToMessages(roomId);
        listenToRoomPranks(roomId);
        listenToPersonalPranks(roomId);
        listenToGameCenter(roomId);

    } catch (error) {
        if (requestVersion === roomOpenRequestVersion) {
            showRoomMessage(showError(error));
        }
    } finally {
        if (openingRoomId === roomId) {
            openingRoomId = null;
        }
    }
}

// Account settings are displayed above the current screen. Keep the room's
// Firestore subscriptions alive while the settings overlay is open.

// BACK TO DASHBOARD

$("backToDashboard").addEventListener("click", () => {

    stopMemberListener();

    $("roomView").hidden = true;
    $("dashboardView").hidden = false;
    $("bannedSection").hidden = true;

    loadRooms();
});

// LEAVE ROOM OR DELETE ROOM

async function deleteActiveRoom() {
    if (!currentUser || !activeRoomId || activeRoomOwnerId !== currentUser.uid) {
        return;
    }

    const roomId = activeRoomId;
    const roomName = $("activeRoomName").textContent || "Bu oda";
    const inviteCode = activeRoomCode;

    const confirmed = window.confirm(
        `"${roomName}" odasını kalıcı olarak silmek istiyor musun?\n\nÜyeler, davet kodu ve ban kayıtları da silinecek. Bu işlem geri alınamaz.`
    );

    if (!confirmed) return;

    const button = $("leaveRoomButton");
    button.disabled = true;
    button.textContent = "Oda siliniyor...";
    isDeletingRoom = true;

    try {
        // Fetch all child records while the owner still has access.
        const [membersSnapshot, bansSnapshot, messagesSnapshot, activePrankSnapshot, gameSessionSnapshot] = await Promise.all([
            getDocs(collection(db, "rooms", roomId, "members")),
            getDocs(collection(db, "rooms", roomId, "bans")),
            getDocs(collection(db, "rooms", roomId, "messages")),
            getDoc(doc(db, "rooms", roomId, "pranks", "active")),
            getDoc(doc(db, "rooms", roomId, "gameSessions", "active"))
        ]);

        // Remove other members and their personal room-list entries.
        // Keep the owner's own membership until the final atomic batch.
        const referencesToDelete = [];

        membersSnapshot.forEach((memberDoc) => {
            referencesToDelete.push(
                doc(db, "rooms", roomId, "prankInbox", memberDoc.id)
            );
            if (memberDoc.id === currentUser.uid) return;

            referencesToDelete.push(memberDoc.ref);
            referencesToDelete.push(
                doc(db, "users", memberDoc.id, "rooms", roomId)
            );
            referencesToDelete.push(
                doc(db, "rooms", roomId, "prankInbox", memberDoc.id)
            );
        });

        // Remove all ban records.
        bansSnapshot.forEach((banDoc) => {
            referencesToDelete.push(banDoc.ref);
        });

        // Firestore does not delete subcollections with their parent document.
        // Explicitly remove every room message before deleting the room.
        messagesSnapshot.forEach((messageDoc) => {
            referencesToDelete.push(messageDoc.ref);
        });
        if (activePrankSnapshot.exists()) {
            referencesToDelete.push(activePrankSnapshot.ref);
        }
        if (gameSessionSnapshot.exists()) {
            referencesToDelete.push(gameSessionSnapshot.ref);
        }
        // Keep batches small so security-rule document lookups stay
        // comfortably below Firestore's per-request access-call limits.
        for (let index = 0; index < referencesToDelete.length; index += 10) {
            const batch = writeBatch(db);
            const chunk = referencesToDelete.slice(index, index + 10);

            for (const reference of chunk) {
                batch.delete(reference);
            }

            await batch.commit();
        }

        // Delete the owner's records, invite and room together.
        // Firestore Rules will allow this only when the room is deleted
        // in the same final batch.
        const finalBatch = writeBatch(db);

        finalBatch.delete(
            doc(db, "rooms", roomId, "members", currentUser.uid)
        );
        finalBatch.delete(
            doc(db, "users", currentUser.uid, "rooms", roomId)
        );
        finalBatch.delete(doc(db, "roomInvites", inviteCode));
        finalBatch.delete(doc(db, "rooms", roomId));

        await finalBatch.commit();

        stopMemberListener();
        activeRoomCode = "";
        $("roomView").hidden = true;
        $("dashboardView").hidden = false;
        $("bannedSection").hidden = true;

        await loadRooms();
        showRoomMessage("Oda ve tüm kayıtları başarıyla silindi.", true);
    } catch (error) {
        isDeletingRoom = false;
        button.disabled = false;
        button.textContent = "Odayı sil";
        console.error("CACA room deletion failed:", error);
        showRoomMessage("Oda silinemedi: " + showError(error));
    }
}

async function removeSelfFromActiveGame(roomId) {
    if (!currentUser || !roomId) return;
    try {
        const activeSessionRef = doc(db, "rooms", roomId, "gameSessions", "active");
        const activeSessionSnapshot = await getDoc(activeSessionRef);
        if (activeSessionSnapshot.exists()) {
            const activeSession = activeSessionSnapshot.data();
            const activeMatchPlayers = Array.isArray(activeSession.matchPlayerIds)
                ? activeSession.matchPlayerIds
                : [];
            if (
                activeSession.gameId === "uno" &&
                activeSession.status === "playing" &&
                activeMatchPlayers.includes(currentUser.uid)
            ) {
                await leaveUnoMatchFromSession(roomId, activeSession, currentUser.uid);
                return;
            }
            if (
                activeSession.gameId === "vampir-koylu" &&
                ["playing", "results"].includes(activeSession.status) &&
                activeMatchPlayers.includes(currentUser.uid)
            ) {
                await leaveVampirKoyluMatchFromSession(roomId, activeSession, currentUser.uid);
                return;
            }
        }

        await runTransaction(db, async (transaction) => {
            const sessionRef = doc(db, "rooms", roomId, "gameSessions", "active");
            const snapshot = await transaction.get(sessionRef);
            if (!snapshot.exists()) return;

            const session = snapshot.data();
            const uid = currentUser.uid;
            const players = Array.isArray(session.playerIds) ? session.playerIds : [];
            const readyIds = Array.isArray(session.readyIds) ? session.readyIds : [];
            const matchPlayers = Array.isArray(session.matchPlayerIds)
                ? session.matchPlayerIds
                : (["playing", "results"].includes(session.status) ? players : []);
            const spectators = Array.isArray(session.spectatorIds) ? session.spectatorIds : [];
            const nextPlayers = Array.isArray(session.nextRoundPlayerIds) ? session.nextRoundPlayerIds : [];
            const nextReady = Array.isArray(session.nextRoundReadyIds) ? session.nextRoundReadyIds : [];
            const isHost = session.hostId === uid;

            const remainingPlayers = players.filter((id) => id !== uid);
            const remainingReady = readyIds.filter((id) => id !== uid);
            const remainingMatchPlayers = matchPlayers.filter((id) => id !== uid);
            let remainingSpectators = spectators.filter((id) => id !== uid);
            const remainingNextPlayers = nextPlayers.filter((id) => id !== uid);
            const remainingNextReady = nextReady.filter((id) => id !== uid);

            const hasParticipation = players.includes(uid) ||
                readyIds.includes(uid) ||
                matchPlayers.includes(uid) ||
                spectators.includes(uid) ||
                nextPlayers.includes(uid) ||
                nextReady.includes(uid);
            if (!hasParticipation && !isHost) return;

            if (isHost && remainingPlayers.length === 0) {
                transaction.delete(sessionRef);
                return;
            }
            const isFinalUnoPlayer = session.status === "playing"
                && session.gameId === "uno"
                && matchPlayers.length === 1
                && matchPlayers.includes(uid);

            if (isFinalUnoPlayer) {
                const updates = {
                    status: "lobby",
                    round: (Number(session.round) || 1) + 1,
                    playerIds: remainingPlayers,
                    readyIds: [],
                    matchPlayerIds: [],
                    spectatorIds: [],
                    nextRoundPlayerIds: [],
                    nextRoundReadyIds: [],
                    startedAt: null,
                    countdownEndsAt: null,
                    finishedAt: null,
                    updatedAt: serverTimestamp()
                };
                if (isHost) updates.hostId = remainingPlayers[0];
                transaction.update(sessionRef, updates);
                return;
            }

            const nextHostId = isHost ? remainingPlayers[0] : null;
            const nextPlayerIds = remainingPlayers;

            const updates = { updatedAt: serverTimestamp() };
            if (players.includes(uid)) updates.playerIds = nextPlayerIds;
            if (readyIds.includes(uid)) updates.readyIds = remainingReady;
            if (matchPlayers.includes(uid)) updates.matchPlayerIds = remainingMatchPlayers;
            if (spectators.includes(uid)) updates.spectatorIds = remainingSpectators;
            if (nextPlayers.includes(uid)) updates.nextRoundPlayerIds = remainingNextPlayers;
            if (nextReady.includes(uid)) updates.nextRoundReadyIds = remainingNextReady;

            if (session.status === "starting" &&
                (players.includes(uid) || isHost)) {
                updates.status = "lobby";
                updates.countdownEndsAt = null;
            }
            if (isHost) updates.hostId = nextHostId;

            transaction.update(sessionRef, updates);
        });
    } catch (error) {
        console.warn("CACA game participant cleanup failed:", error);
        throw error;
    }
}
$("leaveRoomButton").addEventListener("click", async () => {
    if (!currentUser || !activeRoomId) return;

    if (activeRoomOwnerId === currentUser.uid) {
        await deleteActiveRoom();
        return;
    }

    if (!window.confirm("Bu odadan ayrılmak istiyor musun?")) return;

    const roomId = activeRoomId;
    const button = $("leaveRoomButton");
    button.disabled = true;

    try {
        await removeSelfFromActiveGame(roomId);

        // Stop listeners before removing our own membership document.
        stopMemberListener();

        const batch = writeBatch(db);
        batch.delete(doc(db, "rooms", roomId, "members", currentUser.uid));
        batch.delete(doc(db, "users", currentUser.uid, "rooms", roomId));
        batch.delete(doc(db, "rooms", roomId, "prankInbox", currentUser.uid));
        await batch.commit();

        $("roomView").hidden = true;
        $("dashboardView").hidden = false;
        await loadRooms();
        showRoomMessage("Odadan ayrıldın.", true);
    } catch (error) {
        button.disabled = false;
        showRoomMessage(showError(error));
    }
});

// COPY INVITE CODE

$("copyRoomCode").addEventListener("click", async () => {

    try {
        await navigator.clipboard.writeText(activeRoomCode);

        $("copyRoomCode").textContent = "Kopyalandı!";

        setTimeout(() => {
            $("copyRoomCode").textContent = "Kopyala";
        }, 1500);

    } catch (error) {
        console.error(error);
        showRoomMessage("Kod kopyalanamadı. Kodu elle seçebilirsin.");
    }
});

// AUTH STATE

onAuthStateChanged(auth, async (user) => {

    if (!user) {
        stopMemberListener();

        currentUser = null;
        jumpscareLibraryLoadedFor = null;
        jumpscareLibraryLoadPromise = null;
        currentJumpscareSlots = { slot1: null, slot2: null, slot3: null };
        selectedJumpscareSlot = "slot1";
        lastSeenPersonalPrankEventId = null;
        currentUsername = "";
        currentAvatarId = DEFAULT_AVATAR_ID;
        currentAvatarData = null;
        publicProfileCache.clear();
        activeRoomCode = "";

        $("roomsList").replaceChildren();
        $("roomCount").textContent = "0 oda";
        $("bannedSection").hidden = true;

        return;
    }

    if (currentUser?.uid !== user.uid) {
        jumpscareLibraryLoadedFor = null;
        jumpscareLibraryLoadPromise = null;
        currentJumpscareSlots = { slot1: null, slot2: null, slot3: null };
        selectedJumpscareSlot = "slot1";
        lastSeenPersonalPrankEventId = null;
    }
    currentUser = user;

    try {
        const profileSnapshot = await getDoc(
            doc(db, "users", user.uid)
        );

        if (!profileSnapshot.exists()) {
            throw new Error("Kullanıcı profili bulunamadı.");
        }

        const profile = profileSnapshot.data();
        currentUsername = profile.nickname || profile.username;
        currentAvatarId = AVATARS[profile.avatarId]
            ? profile.avatarId
            : DEFAULT_AVATAR_ID;
        currentAvatarData = profile.avatarData || null;

        publicProfileCache.clear();
        await loadRooms();

    } catch (error) {
        showRoomMessage(showError(error));
    }
});
