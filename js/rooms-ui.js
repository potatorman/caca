import { auth, db } from "./firebase.js";
import { AVATARS, DEFAULT_AVATAR_ID, setAvatarElement } from "./avatars.js";
import { EMOJI_DATA } from "./emoji-data.js";

import {
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";

import {
    addDoc,
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
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

// USER STATE

let currentUser = null;
let currentUsername = "";
let currentAvatarId = DEFAULT_AVATAR_ID;
let currentAvatarData = null;
let activeRoomCode = "";
let activeRoomId = null;

// Realtime listener for room members
let unsubscribeMembers = null;
let unsubscribeMyMembership = null;
let unsubscribeBanned = null;
let unsubscribeMessages = null;
let activeRoomOwnerId = null;
let memberRenderVersion = 0;
let bannedRenderVersion = 0;
let isDeletingRoom = false;
let messageRenderVersion = 0;
const publicProfileCache = new Map();
const liveProfileUnsubscribers = new Map();

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

    stopLiveProfileListeners();

    messageRenderVersion += 1;
    activeRoomId = null;
    activeRoomOwnerId = null;
    if ($("roomManagementPanel")) $("roomManagementPanel").hidden = true;
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

    for (const list of [$("membersList"), $("bannedList")]) {
        if (!list) continue;

        const item = Array.from(
            list.querySelectorAll("[data-user-id]")
        ).find((element) => element.dataset.userId === userId);

        if (!item) continue;

        const avatar = item.querySelector(".member-avatar");
        if (avatar) setAvatarElement(avatar, avatarId, avatarData);

        const nickname = item.querySelector(".member-display-name");
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
        $("clearChatHistoryButton").focus();
    } else {
        $("roomManagementButton")?.focus();
    }
}

$("roomManagementButton").addEventListener("click", () => setRoomManagementOpen(true));
$("closeRoomManagementButton").addEventListener("click", () => setRoomManagementOpen(false));
$("roomManagementPanel").addEventListener("click", (event) => {
    if (event.target === $("roomManagementPanel")) setRoomManagementOpen(false);
});
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("roomManagementPanel").hidden) {
        setRoomManagementOpen(false);
    }
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
                if (isMine || canDelete) {
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
    return 99;
}

function renderEmojiAutocomplete() {
    const cursor = chatInput.selectionStart ?? chatInput.value.length;
    const beforeCursor = chatInput.value.slice(0, cursor);
    const match = beforeCursor.match(/(^|\\s):([a-z0-9_+-]{1,32})$/i);

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
    if (emojiAutocomplete.hidden || !emojiAutocompleteItems.length) return false;

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

    if (event.key === "Escape") {
        event.preventDefault();
        closeEmojiAutocomplete();
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

    if (activeRoomId) {
        const roomId = activeRoomId;
        const ownerId = activeRoomOwnerId;
        listenToMembers(roomId, ownerId);
        listenToMessages(roomId);
    }
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

            heading.textContent = `Oda üyeleri (${snapshot.size})`;

            if (snapshot.empty) {
                const empty = document.createElement("p");
                empty.className = "empty-rooms";
                empty.textContent = "Bu odada henüz üye yok.";

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

            // Show room owner first, then sort by nickname.
            members.sort((a, b) => {
                if (a.role === "owner") return -1;
                if (b.role === "owner") return 1;

                return (a.displayNickname || "").localeCompare(
                    b.displayNickname || ""
                );
            });

            for (const member of members) {

                const item = document.createElement("div");
                item.className = "member-item";
                item.dataset.userId = member.id;

                const avatar = document.createElement("div");
                avatar.className = "member-avatar";
                setAvatarElement(avatar, member.avatarId, member.avatarData);

                const info = document.createElement("div");
                info.className = "member-info";

                const nickname = document.createElement("strong");
                nickname.className = "member-display-name";
                nickname.textContent = member.displayNickname;

                const username = document.createElement("span");
                username.className = "member-account-username";

                const usernameDiffers =
                    member.accountUsername.trim().toLowerCase() !==
                    member.displayNickname.trim().toLowerCase();

                username.textContent = usernameDiffers
                    ? `(${member.accountUsername})`
                    : "";
                username.hidden = !usernameDiffers;

                const role = document.createElement("span");
                role.className = "member-role";
                role.textContent =
                    member.role === "owner" ? "Oda sahibi" : "Üye";

                info.append(nickname, username, role);
                item.append(avatar, info);

                const ownerIsViewing = currentUser.uid === activeRoomOwnerId;

                if (ownerIsViewing && member.id !== activeRoomOwnerId) {
                    const actions = document.createElement("div");
                    actions.className = "member-actions";

                    const kickButton = document.createElement("button");
                    kickButton.type = "button";
                    kickButton.className = "member-action-button";
                    kickButton.textContent = "Kick";
                    kickButton.addEventListener("click", () => {
                        manageMember(member, "kick");
                    });

                    const banButton = document.createElement("button");
                    banButton.type = "button";
                    banButton.className = "member-action-button ban";
                    banButton.textContent = "Ban";
                    banButton.addEventListener("click", () => {
                        manageMember(member, "ban");
                    });

                    actions.append(kickButton, banButton);
                    item.appendChild(actions);
                }

                membersList.appendChild(item);
            }

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
            heading.textContent = `Banlı kullanıcılar (${snapshot.size})`;

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
    if (!currentUser || !activeRoomId || activeRoomOwnerId !== currentUser.uid) {
        return;
    }

    if (member.id === activeRoomOwnerId) {
        showRoomMessage("Oda kurucusu kendisini odadan çıkaramaz.");
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

        batch.delete(memberRef);
        batch.delete(userRoomRef);
        await batch.commit();

        showRoomMessage(
            action === "ban"
                ? `${member.username || "Kullanıcı"} odadan banlandı.`
                : `${member.username || "Kullanıcı"} odadan çıkarıldı.`,
            true
        );
    } catch (error) {
        showRoomMessage(showError(error));
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
        showRoomMessage(`${username} kullanıcısının banı kaldırıldı.`, true);
    } catch (error) {
        showRoomMessage(showError(error));
    }
}

// OPEN ROOM

async function openRoom(roomId) {
    if (!currentUser) return;

    try {

        isDeletingRoom = false;

        const banSnapshot = await getDoc(
            doc(db, "rooms", roomId, "bans", currentUser.uid)
        );

        if (banSnapshot.exists()) {
            throw new Error(
                "Bu odadan banlandın. Oda sahibi banını kaldırana kadar tekrar katılamazsın."
            );
        }

        // Verify that this user belongs to the room.
        const membership = await getDoc(
            doc(db, "users", currentUser.uid, "rooms", roomId)
        );

        if (!membership.exists()) {
            throw new Error("Bu odaya erişim iznin yok.");
        }

        const roomSnapshot = await getDoc(
            doc(db, "rooms", roomId)
        );

        if (!roomSnapshot.exists()) {
            throw new Error("Oda bulunamadı.");
        }

        const room = roomSnapshot.data();

        $("activeRoomName").textContent = room.name;
        $("activeRoomCode").textContent = room.inviteCode;

        activeRoomCode = room.inviteCode;

        const isOwner = room.ownerId === currentUser.uid;
        $("bannedSection").hidden = !isOwner;
        $("roomManagementButton").hidden = !isOwner;
        $("roomManagementPanel").hidden = true;

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

        // Start live member and chat updates.
        listenToMembers(roomId, room.ownerId);
        listenToMessages(roomId);

    } catch (error) {
        showRoomMessage(showError(error));
    }
}

// SETTINGS NAVIGATION: stop any open room listeners before leaving the room.

document.addEventListener("caca:open-settings", () => {
    stopMemberListener();
    $("roomView").hidden = true;
    $("dashboardView").hidden = true;
    $("bannedSection").hidden = true;
});

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
        const [membersSnapshot, bansSnapshot, messagesSnapshot] = await Promise.all([
            getDocs(collection(db, "rooms", roomId, "members")),
            getDocs(collection(db, "rooms", roomId, "bans")),
            getDocs(collection(db, "rooms", roomId, "messages"))
        ]);

        // Remove other members and their personal room-list entries.
        // Keep the owner's own membership until the final atomic batch.
        const referencesToDelete = [];

        membersSnapshot.forEach((memberDoc) => {
            if (memberDoc.id === currentUser.uid) return;

            referencesToDelete.push(memberDoc.ref);
            referencesToDelete.push(
                doc(db, "users", memberDoc.id, "rooms", roomId)
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
        // Stop listeners before removing our own membership document.
        stopMemberListener();

        const batch = writeBatch(db);
        batch.delete(doc(db, "rooms", roomId, "members", currentUser.uid));
        batch.delete(doc(db, "users", currentUser.uid, "rooms", roomId));
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
