import { auth, db } from "./firebase.js";
import { setAvatarElement } from "./avatars.js";
import { UNO_WORKER_URL } from "../games/uno/worker-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
    collection,
    doc,
    getDoc,
    getDocs,
    onSnapshot,
    query,
    orderBy,
    limit,
    writeBatch,
    deleteDoc
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

let currentUser = null;
let isSiteOwner = false;
let unsubscribeRooms = null;
let unsubscribeMessages = null;
let unsubscribeUsers = null;
let unsubscribeRoomMembers = null;
let ownerUserProfiles = [];
let ownerRoomMembers = [];
let selectedOwnerUserIds = new Set();
let ownerRoomMembersVersion = 0;
let selectedChat = null;
let messageRenderVersion = 0;
let previousWorkspace = null;

function renderOwnerAccess() {
    window.cacaIsSiteOwner = isSiteOwner;
    if ($("siteOwnerBadge")) $("siteOwnerBadge").hidden = !isSiteOwner;
    if ($("siteOwnerNavButton")) $("siteOwnerNavButton").hidden = !isSiteOwner;
    document.dispatchEvent(new CustomEvent("caca:site-owner-role-changed", {
        detail: { isSiteOwner }
    }));
}

function stopOwnerListeners() {
    if (unsubscribeRooms) {
        unsubscribeRooms();
        unsubscribeRooms = null;
    }
    if (unsubscribeMessages) {
        unsubscribeMessages();
        unsubscribeMessages = null;
    }
    if (unsubscribeUsers) {
        unsubscribeUsers();
        unsubscribeUsers = null;
    }
    if (unsubscribeRoomMembers) {
        unsubscribeRoomMembers();
        unsubscribeRoomMembers = null;
    }
    $("ownerRoomMembersPanel")?.setAttribute("hidden", "");
    $("ownerRoomMembersList")?.replaceChildren();
    ownerUserProfiles = [];
    ownerRoomMembers = [];
    selectedOwnerUserIds.clear();
    ownerRoomMembersVersion += 1;
    messageRenderVersion += 1;
}

function restorePreviousWorkspace() {
    if (!previousWorkspace) return;
    const previous = previousWorkspace;
    const workspace = document.querySelector(".workspace-layout");
    document.querySelector(".room-sidebar").hidden = previous.sidebarHidden;
    $("settingsView").hidden = previous.settingsHidden;
    $("siteOwnerView").hidden = true;

    // Restore one coherent screen. A room/chat takes precedence over the
    // welcome dashboard so the two screens can never appear on top of each other.
    const returnToRoom = previous.roomHidden === false;
    const returnToGames = !returnToRoom && previous.gamesHidden === false;
    $("roomView").hidden = !returnToRoom;
    $("gamesView").hidden = !returnToGames;
    $("dashboardView").hidden = returnToRoom || returnToGames;
    workspace.classList.toggle("is-games-workspace", returnToGames);
    workspace.classList.remove("is-site-owner-workspace");
    previousWorkspace = null;
    $("siteOwnerNavButton").classList.remove("is-active");
    $("siteOwnerNavButton").setAttribute("aria-pressed", "false");
}

function setSelectedChatButton(type, roomId = "") {
    $("ownerGlobalChatButton").classList.toggle("is-active", type === "global");
    $("ownerRoomsList").querySelectorAll(".owner-room-choice").forEach((button) => {
        button.classList.toggle("is-active", type === "room" && button.dataset.roomId === roomId);
    });
}

function formatOwnerMessageTime(timestamp) {
    if (!timestamp || typeof timestamp.toDate !== "function") return "Şimdi";
    return new Intl.DateTimeFormat("tr-TR", {
        dateStyle: "medium",
        timeStyle: "short"
    }).format(timestamp.toDate());
}

function getOwnerChatCollection(selection = selectedChat) {
    if (!selection) throw new Error("Önce bir sohbet seç.");
    return selection.type === "global"
        ? collection(db, "globalChatMessages")
        : collection(db, "rooms", selection.id, "messages");
}

function openOwnerChat(type, id, title) {
    if (!isSiteOwner) return;
    if (unsubscribeMessages) {
        unsubscribeMessages();
        unsubscribeMessages = null;
    }
    selectedChat = { type, id };
    messageRenderVersion += 1;
    $("ownerChatTitle").textContent = title;
    $("ownerChatStatus").textContent = "Mesajlar yükleniyor...";
    $("ownerChatMessages").replaceChildren();
    $("ownerClearChatButton").disabled = false;
    $("ownerDeleteChatButton").disabled = type !== "room";
    setSelectedChatButton(type, id);
    if (type === "room") {
        listenToOwnerRoomMembers(id);
    } else {
        stopOwnerRoomMembersListener();
    }

    const messagesQuery = query(getOwnerChatCollection(), orderBy("createdAt", "desc"), limit(100));
    unsubscribeMessages = onSnapshot(messagesQuery, async (snapshot) => {
        const version = ++messageRenderVersion;
        const messageDocs = [...snapshot.docs].reverse();
        const senderIds = [...new Set(messageDocs.map((item) => item.data().senderId).filter(Boolean))];
        const profiles = new Map(await Promise.all(senderIds.map(async (userId) => {
            const profileSnapshot = await getDoc(doc(db, "users", userId));
            return [userId, profileSnapshot.exists() ? profileSnapshot.data() : null];
        })));
        if (!isSiteOwner || version !== messageRenderVersion) return;

        const list = $("ownerChatMessages");
        list.replaceChildren();
        $("ownerChatStatus").textContent = snapshot.size >= 100
            ? "Son 100 mesaj gösteriliyor."
            : String(snapshot.size) + " mesaj";

        if (snapshot.empty) {
            const empty = document.createElement("p");
            empty.className = "owner-console-empty";
            empty.textContent = "Bu sohbette henüz mesaj yok.";
            list.appendChild(empty);
            $("ownerClearChatButton").disabled = true;
            return;
        }

        $("ownerClearChatButton").disabled = false;
        for (const messageDoc of messageDocs) {
            const message = messageDoc.data();
            const profile = profiles.get(message.senderId);
            const username = profile?.username || message.senderName || "Kullanıcı";
            const nickname = profile?.nickname || username;

            const row = document.createElement("article");
            row.className = "owner-message-row";
            row.dataset.messageId = messageDoc.id;

            const avatar = document.createElement("div");
            avatar.className = "member-avatar owner-message-avatar";
            setAvatarElement(avatar, profile?.avatarId || message.senderAvatarId, profile?.avatarData || null);

            const content = document.createElement("div");
            content.className = "owner-message-content";
            const meta = document.createElement("div");
            meta.className = "owner-message-meta";
            const author = document.createElement("strong");
            author.textContent = nickname;
            meta.appendChild(author);
            if (profile?.siteRole === "site_owner") {
                const badge = document.createElement("span");
                badge.className = "site-owner-message-badge";
                badge.textContent = "SITE OWNER";
                meta.appendChild(badge);
            }
            const time = document.createElement("time");
            time.textContent = formatOwnerMessageTime(message.createdAt);
            meta.appendChild(time);

            const body = document.createElement("div");
            body.className = "owner-message-text";
            body.textContent = typeof message.text === "string" ? message.text : "";
            content.append(meta, body);

            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "owner-message-delete";
            remove.textContent = "Sil";
            remove.addEventListener("click", () => deleteOwnerMessage(messageDoc.id));
            row.append(avatar, content, remove);
            list.appendChild(row);
        }
        list.scrollTop = list.scrollHeight;
    }, (error) => {
        console.error("CACA owner message listener failed:", error);
        $("ownerChatStatus").textContent = "Sohbet yüklenemedi: " + (error.message || "Bilinmeyen hata");
    });
}

function listenToOwnerRooms() {
    if (unsubscribeRooms || !isSiteOwner) return;
    const roomsQuery = query(collection(db, "rooms"), orderBy("createdAt", "desc"));
    unsubscribeRooms = onSnapshot(roomsQuery, (snapshot) => {
        if (!isSiteOwner) return;
        const list = $("ownerRoomsList");
        list.replaceChildren();
        $("ownerRoomCount").textContent = String(snapshot.size);

        if (snapshot.empty) {
            const empty = document.createElement("p");
            empty.className = "owner-console-empty";
            empty.textContent = "Henüz oluşturulmuş özel oda yok.";
            list.appendChild(empty);
            return;
        }

        for (const roomDoc of snapshot.docs) {
            const room = roomDoc.data();
            const button = document.createElement("button");
            button.type = "button";
            button.className = "owner-room-choice";
            button.dataset.roomId = roomDoc.id;
            const copy = document.createElement("span");
            const title = document.createElement("strong");
            title.textContent = room.name || "İsimsiz oda";
            const subtitle = document.createElement("small");
            subtitle.textContent = "Özel oda sohbeti";
            copy.append(title, subtitle);
            button.appendChild(copy);
            button.addEventListener("click", () => openOwnerChat("room", roomDoc.id, room.name || "Özel oda"));
            list.appendChild(button);
        }

        if (selectedChat?.type === "room") setSelectedChatButton("room", selectedChat.id);
    }, (error) => {
        console.error("CACA owner room list failed:", error);
        $("ownerChatStatus").textContent = "Odalar listelenemedi: " + (error.message || "Bilinmeyen hata");
    });
}

async function deleteOwnerMessage(messageId) {
    if (!isSiteOwner || !selectedChat) return;
    if (!window.confirm("Bu mesajı kalıcı olarak silmek istiyor musun?")) return;
    try {
        await deleteDoc(doc(getOwnerChatCollection(), messageId));
        $("ownerChatStatus").textContent = "Mesaj silindi.";
    } catch (error) {
        console.error("CACA owner message delete failed:", error);
        $("ownerChatStatus").textContent = "Mesaj silinemedi: " + (error.message || "Bilinmeyen hata");
    }
}

async function clearOwnerChatHistory() {
    if (!isSiteOwner || !selectedChat) return;
    const title = $("ownerChatTitle").textContent || "Bu sohbet";
    if (!window.confirm(title + " içindeki tüm mesajları kalıcı olarak silmek istiyor musun? Bu işlem geri alınamaz.")) return;

    const button = $("ownerClearChatButton");
    const oldLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Temizleniyor...";
    $("ownerChatStatus").textContent = "Sohbet geçmişi siliniyor...";
    try {
        let deletedCount = 0;
        const messageCollection = getOwnerChatCollection();
        while (true) {
            const snapshot = await getDocs(query(messageCollection, limit(400)));
            if (snapshot.empty) break;
            const batch = writeBatch(db);
            snapshot.docs.forEach((messageDoc) => batch.delete(messageDoc.ref));
            await batch.commit();
            deletedCount += snapshot.size;
        }
        $("ownerChatStatus").textContent = String(deletedCount) + " mesaj silindi.";
    } catch (error) {
        console.error("CACA owner chat clear failed:", error);
        $("ownerChatStatus").textContent = "Sohbet temizlenemedi: " + (error.message || "Bilinmeyen hata");
    } finally {
        button.textContent = oldLabel;
        button.disabled = false;
    }
}

async function deleteOwnerChat() {
    if (!isSiteOwner || !currentUser || !selectedChat || selectedChat.type !== "room") return;

    const roomId = selectedChat.id;
    const chatTitle = $("ownerChatTitle").textContent || "Bu sohbet";
    if (!window.confirm(
        '"' + chatTitle + '" odasını ve sohbetini tamamen silmek istiyor musun? ' +
        "Oda üyeleri, mesajlar, davet kaydı ve bu odaya ait oyun verileri de silinir. Bu işlem geri alınamaz."
    )) return;

    const button = $("ownerDeleteChatButton");
    const oldLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Siliniyor...";
    $("ownerChatStatus").textContent = "Oda ve sohbet siliniyor...";

    try {
        const idToken = await currentUser.getIdToken();
        const response = await fetch(UNO_WORKER_URL + "/api/site-owner/delete-room", {
            method: "POST",
            headers: {
                Authorization: "Bearer " + idToken,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ roomId })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || "Sohbet silinemedi.");

        if (unsubscribeMessages) {
            unsubscribeMessages();
            unsubscribeMessages = null;
        }
        selectedChat = null;
        $("ownerChatStatus").textContent = '"' + chatTitle + '" odası ve sohbeti silindi.';
        openOwnerChat("global", "__caca_global_chat__", "Global Chat");
    } catch (error) {
        console.error("CACA owner chat delete failed:", error);
        $("ownerChatStatus").textContent = "Sohbet silinemedi: " + (error.message || "Bilinmeyen hata");
        button.disabled = false;
        button.textContent = oldLabel;
    }
}

function formatOwnerUserDate(timestamp) {
    if (!timestamp || typeof timestamp.toDate !== "function") return "Kayıt tarihi bilinmiyor";
    return new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium" }).format(timestamp.toDate());
}

function normalizeOwnerSearch(value) {
    return String(value || "").trim().toLocaleLowerCase("tr-TR");
}

function getOwnerUserLabel(uid, profile = {}, membership = {}) {
    const username = profile.username || membership.username || "isimsiz";
    return {
        username,
        nickname: profile.nickname || membership.username || username
    };
}

async function deleteOwnerAccounts(uids) {
    if (!isSiteOwner || !currentUser) throw new Error("Site Owner oturumu bulunamadı.");
    const uniqueUids = [...new Set(uids)].filter((uid) => uid && uid !== currentUser.uid);
    if (!uniqueUids.length) throw new Error("Silinecek hesap seçilmedi.");
    if (uniqueUids.length > 25) throw new Error("Tek seferde en fazla 25 hesap silebilirsin.");

    const idToken = await currentUser.getIdToken();
    const response = await fetch(UNO_WORKER_URL + "/api/site-owner/delete-user", {
        method: "POST",
        headers: {
            Authorization: "Bearer " + idToken,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ uids: uniqueUids })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Hesaplar silinemedi.");
    return result;
}

function renderOwnerRoomMembers() {
    const list = $("ownerRoomMembersList");
    if (!list) return;

    const search = normalizeOwnerSearch($("ownerRoomMemberSearch")?.value);
    const filtered = ownerRoomMembers.filter(({ uid, profile, membership }) => {
        const { username, nickname } = getOwnerUserLabel(uid, profile, membership);
        return !search || [uid, username, nickname].some((value) => normalizeOwnerSearch(value).includes(search));
    });

    $("ownerRoomMembersCount").textContent = String(ownerRoomMembers.length);
    $("ownerRoomMembersStatus").textContent = search
        ? filtered.length + " / " + ownerRoomMembers.length + " üye eşleşti."
        : ownerRoomMembers.length + " oda üyesi";

    list.replaceChildren();
    if (!filtered.length) {
        const empty = document.createElement("p");
        empty.className = "owner-console-empty";
        empty.textContent = ownerRoomMembers.length
            ? "Aramana uygun oda üyesi bulunamadı."
            : "Bu odada henüz üye bulunmuyor.";
        list.appendChild(empty);
        return;
    }

    for (const { uid, profile, membership } of filtered) {
        const { username, nickname } = getOwnerUserLabel(uid, profile, membership);
        const isOwner = profile?.siteRole === "site_owner";
        const isCurrentAccount = uid === currentUser?.uid;

        const row = document.createElement("article");
        row.className = "owner-user-row";

        const avatar = document.createElement("div");
        avatar.className = "member-avatar owner-user-avatar";
        setAvatarElement(avatar, profile?.avatarId, profile?.avatarData || null);

        const details = document.createElement("div");
        details.className = "owner-user-details";
        const heading = document.createElement("div");
        heading.className = "owner-user-heading";
        const name = document.createElement("strong");
        name.textContent = nickname;
        heading.appendChild(name);

        if (isOwner) {
            const badge = document.createElement("span");
            badge.className = "site-owner-message-badge";
            badge.textContent = "SITE OWNER";
            heading.appendChild(badge);
        }

        const role = document.createElement("small");
        role.textContent = membership.role === "owner"
            ? "Oda sahibi"
            : membership.role === "admin" ? "Oda yöneticisi" : "Üye";
        const accountName = document.createElement("small");
        accountName.textContent = "@" + username;
        details.append(heading, role, accountName);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "owner-user-delete";
        remove.textContent = isOwner ? "Owner korunuyor" : "Hesabı sil";
        remove.disabled = isOwner || isCurrentAccount;
        if (!remove.disabled) {
            remove.addEventListener("click", () => deleteRoomMemberAccount(uid, nickname, remove));
        }

        row.append(avatar, details, remove);
        list.appendChild(row);
    }
}

function stopOwnerRoomMembersListener() {
    if (unsubscribeRoomMembers) {
        unsubscribeRoomMembers();
        unsubscribeRoomMembers = null;
    }
    ownerRoomMembersVersion += 1;
    ownerRoomMembers = [];
    const panel = $("ownerRoomMembersPanel");
    if (panel) panel.hidden = true;
    $("ownerRoomMembersList")?.replaceChildren();
    if ($("ownerRoomMembersStatus")) $("ownerRoomMembersStatus").textContent = "";
}

function listenToOwnerRoomMembers(roomId) {
    stopOwnerRoomMembersListener();
    const version = ++ownerRoomMembersVersion;
    $("ownerRoomMembersPanel").hidden = false;
    $("ownerRoomMembersStatus").textContent = "Oda üyeleri yükleniyor...";
    $("ownerRoomMembersList").replaceChildren();

    unsubscribeRoomMembers = onSnapshot(
        collection(db, "rooms", roomId, "members"),
        async (snapshot) => {
            const members = await Promise.all(snapshot.docs.map(async (memberDoc) => {
                const uid = memberDoc.id;
                let profile = ownerUserProfiles.find((entry) => entry.uid === uid)?.profile || null;
                if (!profile) {
                    const profileSnapshot = await getDoc(doc(db, "users", uid));
                    profile = profileSnapshot.exists() ? profileSnapshot.data() : null;
                }
                return { uid, profile: profile || {}, membership: memberDoc.data() };
            }));

            if (!isSiteOwner || version !== ownerRoomMembersVersion || selectedChat?.type !== "room" || selectedChat.id !== roomId) {
                return;
            }
            ownerRoomMembers = members.sort((a, b) => {
                const aName = getOwnerUserLabel(a.uid, a.profile, a.membership).nickname;
                const bName = getOwnerUserLabel(b.uid, b.profile, b.membership).nickname;
                return aName.localeCompare(bName, "tr");
            });
            renderOwnerRoomMembers();
        },
        (error) => {
            console.error("CACA owner room members listener failed:", error);
            if (version === ownerRoomMembersVersion) {
                $("ownerRoomMembersStatus").textContent =
                    "Oda üyeleri yüklenemedi: " + (error.message || "Bilinmeyen hata");
            }
        }
    );
}

async function deleteRoomMemberAccount(uid, nickname, button) {
    if (!isSiteOwner || !currentUser || uid === currentUser.uid || button.disabled) return;
    const confirmed = window.confirm(
        nickname + " hesabını kalıcı olarak silmek istiyor musun? Hesap tüm CACA verileriyle birlikte silinir."
    );
    if (!confirmed) return;

    const oldLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Siliniyor...";
    $("ownerRoomMembersStatus").textContent = nickname + " hesabı siliniyor...";
    try {
        const result = await deleteOwnerAccounts([uid]);
        const failures = Array.isArray(result.failed) ? result.failed : [];
        $("ownerRoomMembersStatus").textContent = failures.length
            ? nickname + " silinemedi: " + (failures[0].error || "Bilinmeyen hata")
            : nickname + " hesabı kalıcı olarak silindi.";
        selectedOwnerUserIds.delete(uid);
    } catch (error) {
        console.error("CACA room member account delete failed:", error);
        $("ownerRoomMembersStatus").textContent =
            "Hesap silinemedi: " + (error.message || "Bilinmeyen hata");
        if (button.isConnected) {
            button.disabled = false;
            button.textContent = oldLabel;
        }
    }
}

function renderOwnerUsers() {
    const list = $("ownerUsersList");
    if (!list) return;

    const search = normalizeOwnerSearch($("ownerUserSearch")?.value);
    const filtered = ownerUserProfiles.filter(({ uid, profile }) => {
        const values = [uid, profile.username, profile.nickname]
            .filter(Boolean)
            .map(normalizeOwnerSearch);
        return !search || values.some((value) => value.includes(search));
    });

    const eligibleVisible = filtered.filter(({ uid, profile }) =>
        uid !== currentUser?.uid && profile.siteRole !== "site_owner"
    );
    for (const uid of [...selectedOwnerUserIds]) {
        const account = ownerUserProfiles.find((entry) => entry.uid === uid);
        if (!account || uid === currentUser?.uid || account.profile.siteRole === "site_owner") {
            selectedOwnerUserIds.delete(uid);
        }
    }

    $("ownerUserCount").textContent = String(ownerUserProfiles.length);
    $("ownerUsersStatus").textContent = search
        ? filtered.length + " / " + ownerUserProfiles.length + " hesap eşleşti."
        : ownerUserProfiles.length + " kayıtlı hesap";

    const selectVisible = $("ownerSelectVisibleUsers");
    selectVisible.checked = eligibleVisible.length > 0 &&
        eligibleVisible.every(({ uid }) => selectedOwnerUserIds.has(uid));
    selectVisible.indeterminate = eligibleVisible.some(({ uid }) => selectedOwnerUserIds.has(uid)) &&
        !selectVisible.checked;

    const bulkButton = $("ownerBulkDeleteButton");
    bulkButton.textContent = "Seçilenleri sil (" + selectedOwnerUserIds.size + ")";
    bulkButton.disabled = selectedOwnerUserIds.size === 0;

    list.replaceChildren();
    if (!filtered.length) {
        const empty = document.createElement("p");
        empty.className = "owner-console-empty";
        empty.textContent = ownerUserProfiles.length
            ? "Aramana uygun hesap bulunamadı."
            : "Henüz kullanıcı hesabı bulunamadı.";
        list.appendChild(empty);
        return;
    }

    for (const { uid, profile } of filtered) {
        const username = profile.username || "isimsiz";
        const nickname = profile.nickname || username;
        const isOwner = profile.siteRole === "site_owner";
        const isCurrentAccount = uid === currentUser?.uid;

        const row = document.createElement("article");
        row.className = "owner-user-row";

        const select = document.createElement("input");
        select.type = "checkbox";
        select.className = "owner-user-select";
        select.checked = selectedOwnerUserIds.has(uid);
        select.disabled = isOwner || isCurrentAccount;
        select.setAttribute("aria-label", nickname + " hesabını seç");
        select.addEventListener("change", () => {
            if (select.checked && selectedOwnerUserIds.size >= 25) {
                select.checked = false;
                $("ownerUsersStatus").textContent = "Tek seferde en fazla 25 hesap seçebilirsin.";
                return;
            }
            if (select.checked) selectedOwnerUserIds.add(uid);
            else selectedOwnerUserIds.delete(uid);
            renderOwnerUsers();
        });

        const avatar = document.createElement("div");
        avatar.className = "member-avatar owner-user-avatar";
        setAvatarElement(avatar, profile.avatarId, profile.avatarData || null);

        const details = document.createElement("div");
        details.className = "owner-user-details";
        const heading = document.createElement("div");
        heading.className = "owner-user-heading";
        const name = document.createElement("strong");
        name.textContent = nickname;
        heading.appendChild(name);

        if (isOwner) {
            const badge = document.createElement("span");
            badge.className = "site-owner-message-badge";
            badge.textContent = "SITE OWNER";
            heading.appendChild(badge);
        }

        const accountName = document.createElement("small");
        accountName.textContent = "@" + username;
        const uidText = document.createElement("code");
        uidText.textContent = "UID: " + uid;
        const created = document.createElement("small");
        created.textContent = formatOwnerUserDate(profile.createdAt);
        details.append(heading, accountName, uidText, created);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "owner-user-delete";
        remove.textContent = isOwner ? "Owner korunuyor" : "Hesabı sil";
        remove.disabled = isOwner || isCurrentAccount;
        if (!remove.disabled) {
            remove.addEventListener("click", () => deleteOwnerUser(uid, nickname, remove));
        }

        row.append(select, avatar, details, remove);
        list.appendChild(row);
    }
}

function listenToOwnerUsers() {
    if (unsubscribeUsers || !isSiteOwner) return;
    $("ownerUsersStatus").textContent = "Kullanıcı hesapları yükleniyor...";

    unsubscribeUsers = onSnapshot(collection(db, "users"), (snapshot) => {
        if (!isSiteOwner) return;
        ownerUserProfiles = snapshot.docs.map((userDoc) => ({
            uid: userDoc.id,
            profile: userDoc.data()
        })).sort((a, b) => {
            const aTime = a.profile.createdAt?.toMillis?.() || 0;
            const bTime = b.profile.createdAt?.toMillis?.() || 0;
            return bTime - aTime;
        });
        renderOwnerUsers();
        if (selectedChat?.type === "room") renderOwnerRoomMembers();
    }, (error) => {
        console.error("CACA owner user list failed:", error);
        $("ownerUsersStatus").textContent =
            "Kullanıcı listesi yüklenemedi: " + (error.message || "Bilinmeyen hata");
    });
}

async function deleteOwnerUser(uid, nickname, button) {
    if (!isSiteOwner || !currentUser || uid === currentUser.uid || button.disabled) return;
    const confirmed = window.confirm(
        nickname + " hesabını ve Firebase Authentication kaydını kalıcı olarak silmek istiyor musun? " +
        "Bu hesaba ait Global Chat mesajları, oda üyelikleri ve sahibi olduğu odalar da silinir. Bu işlem geri alınamaz."
    );
    if (!confirmed) return;

    const oldLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Siliniyor...";
    $("ownerUsersStatus").textContent = nickname + " hesabı siliniyor...";

    try {
        const result = await deleteOwnerAccounts([uid]);
        const failures = Array.isArray(result.failed) ? result.failed : [];
        selectedOwnerUserIds.delete(uid);
        renderOwnerUsers();
        if (selectedChat?.type === "room") renderOwnerRoomMembers();
        $("ownerUsersStatus").textContent = failures.length
            ? nickname + " silinemedi: " + (failures[0].error || "Bilinmeyen hata")
            : nickname + " hesabı ve ilişkili verileri kalıcı olarak silindi.";
    } catch (error) {
        console.error("CACA owner account deletion failed:", error);
        $("ownerUsersStatus").textContent =
            "Hesap silinemedi: " + (error.message || "Bilinmeyen hata");
        if (button.isConnected) {
            button.disabled = false;
            button.textContent = oldLabel;
        }
    }
}

async function deleteSelectedOwnerUsers() {
    if (!isSiteOwner || !currentUser) return;
    const targets = ownerUserProfiles.filter(({ uid, profile }) =>
        selectedOwnerUserIds.has(uid) && uid !== currentUser.uid && profile.siteRole !== "site_owner"
    );
    if (!targets.length) {
        selectedOwnerUserIds.clear();
        renderOwnerUsers();
        return;
    }
    if (targets.length > 25) {
        $("ownerUsersStatus").textContent = "Tek seferde en fazla 25 hesap silebilirsin. Seçimini azalt.";
        return;
    }

    const names = targets.map(({ profile }) => profile.nickname || profile.username || "İsimsiz").slice(0, 8);
    const extra = targets.length > names.length ? "\\nve " + (targets.length - names.length) + " hesap daha" : "";
    const confirmed = window.confirm(
        targets.length + " hesabı kalıcı olarak silmek istiyor musun?\\n\\n" +
        names.join(", ") + extra +
        "\\n\\nSeçilen hesapların Firebase Authentication kayıtları ve CACA verileri silinir. Bu işlem geri alınamaz."
    );
    if (!confirmed) return;

    const button = $("ownerBulkDeleteButton");
    button.disabled = true;
    const oldLabel = button.textContent;
    button.textContent = "Hesaplar siliniyor...";
    $("ownerUsersStatus").textContent = targets.length + " hesap siliniyor...";

    try {
        const result = await deleteOwnerAccounts(targets.map(({ uid }) => uid));
        const deletedUids = Array.isArray(result.deletedUids) ? result.deletedUids : [];
        const failures = Array.isArray(result.failed) ? result.failed : [];
        deletedUids.forEach((uid) => selectedOwnerUserIds.delete(uid));
        let completionMessage;
        if (!failures.length) {
            selectedOwnerUserIds.clear();
            completionMessage = deletedUids.length + " hesap kalıcı olarak silindi.";
        } else {
            completionMessage =
                deletedUids.length + " hesap silindi; " + failures.length + " hesap silinemedi: " +
                failures.slice(0, 3).map((item) => item.error || item.uid).join(" · ");
        }
        renderOwnerUsers();
        if (selectedChat?.type === "room") renderOwnerRoomMembers();
        $("ownerUsersStatus").textContent = completionMessage;
    } catch (error) {
        console.error("CACA bulk account deletion failed:", error);
        $("ownerUsersStatus").textContent = "Toplu silme başarısız: " + (error.message || "Bilinmeyen hata");
    } finally {
        button.textContent = oldLabel;
        renderOwnerUsers();
    }
}

$("ownerUserSearch")?.addEventListener("input", renderOwnerUsers);
$("ownerRoomMemberSearch")?.addEventListener("input", renderOwnerRoomMembers);
$("ownerSelectVisibleUsers")?.addEventListener("change", (event) => {
    const search = normalizeOwnerSearch($("ownerUserSearch")?.value);
    const visible = ownerUserProfiles.filter(({ uid, profile }) => {
        if (uid === currentUser?.uid || profile.siteRole === "site_owner") return false;
        const values = [uid, profile.username, profile.nickname].filter(Boolean).map(normalizeOwnerSearch);
        return !search || values.some((value) => value.includes(search));
    });
    if (event.currentTarget.checked) {
        const remainingSlots = Math.max(0, 25 - selectedOwnerUserIds.size);
        visible.slice(0, remainingSlots).forEach(({ uid }) => selectedOwnerUserIds.add(uid));
        if (visible.length > remainingSlots) {
            $("ownerUsersStatus").textContent = "En fazla 25 hesap seçildi. Toplu silme sınırı 25 hesap.";
        }
    } else {
        visible.forEach(({ uid }) => selectedOwnerUserIds.delete(uid));
    }
    renderOwnerUsers();
});
$("ownerBulkDeleteButton")?.addEventListener("click", deleteSelectedOwnerUsers);

function openOwnerConsole() {
    if (!isSiteOwner || !currentUser) return;
    if (!previousWorkspace) {
        const workspace = document.querySelector(".workspace-layout");
        previousWorkspace = {
            sidebarHidden: document.querySelector(".room-sidebar").hidden,
            dashboardHidden: $("dashboardView").hidden,
            roomHidden: $("roomView").hidden,
            gamesHidden: $("gamesView").hidden,
            settingsHidden: $("settingsView").hidden,
            gamesWorkspace: workspace.classList.contains("is-games-workspace"),
            ownerWorkspace: workspace.classList.contains("is-site-owner-workspace")
        };
    }

    document.querySelector(".room-sidebar").hidden = true;
    $("dashboardView").hidden = true;
    $("roomView").hidden = true;
    $("gamesView").hidden = true;
    $("settingsView").hidden = true;
    $("siteOwnerView").hidden = false;
    const workspace = document.querySelector(".workspace-layout");
    workspace.classList.remove("is-games-workspace");
    workspace.classList.add("is-site-owner-workspace");

    $("chatsNavButton").classList.remove("is-active");
    $("gamesNavButton").classList.remove("is-active");
    $("chatsNavButton").setAttribute("aria-pressed", "false");
    $("gamesNavButton").setAttribute("aria-pressed", "false");
    $("siteOwnerNavButton").classList.add("is-active");
    $("siteOwnerNavButton").setAttribute("aria-pressed", "true");

    listenToOwnerRooms();
    listenToOwnerUsers();
    if (!selectedChat) openOwnerChat("global", "__caca_global_chat__", "Global Chat");
}

$("siteOwnerNavButton")?.addEventListener("click", openOwnerConsole);
$("ownerGlobalChatButton")?.addEventListener("click", () => {
    openOwnerChat("global", "__caca_global_chat__", "Global Chat");
});
$("ownerClearChatButton")?.addEventListener("click", clearOwnerChatHistory);
$("ownerDeleteChatButton")?.addEventListener("click", deleteOwnerChat);

// Capture phase restores the hidden room/dashboard before the existing tab code runs.
$("chatsNavButton")?.addEventListener("click", restorePreviousWorkspace, true);
$("gamesNavButton")?.addEventListener("click", restorePreviousWorkspace, true);

document.addEventListener("caca:site-owner-activated", () => {
    isSiteOwner = true;
    renderOwnerAccess();
});
document.addEventListener("caca:site-owner-role-changed", (event) => {
    isSiteOwner = event.detail?.isSiteOwner === true;
});

onAuthStateChanged(auth, async (user) => {
    currentUser = user || null;
    isSiteOwner = false;
    stopOwnerListeners();
    previousWorkspace = null;
    $("siteOwnerView").hidden = true;
    document.querySelector(".workspace-layout")?.classList.remove("is-site-owner-workspace");

    if (!currentUser) {
        renderOwnerAccess();
        selectedChat = null;
        return;
    }

    try {
        const profileSnapshot = await getDoc(doc(db, "users", currentUser.uid));
        isSiteOwner = profileSnapshot.exists() && profileSnapshot.data().siteRole === "site_owner";
    } catch (error) {
        console.error("CACA owner role check failed:", error);
    }
    renderOwnerAccess();
});
