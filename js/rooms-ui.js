import { auth, db } from "./firebase.js";

import {
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";

import {
    collection,
    doc,
    getDoc,
    getDocs,
    onSnapshot,
    writeBatch,
    deleteDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

// USER STATE

let currentUser = null;
let currentUsername = "";
let activeRoomCode = "";
let activeRoomId = null;

// Realtime listener for room members
let unsubscribeMembers = null;
let unsubscribeMyMembership = null;
let unsubscribeBanned = null;
let activeRoomOwnerId = null;
let isDeletingRoom = false;

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

    activeRoomId = null;
    activeRoomOwnerId = null;
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

        (snapshot) => {

            // Ignore events from a room that is no longer open.
            if (activeRoomId !== roomId) return;

            const membersList = $("membersList");
            const heading = $("membersHeading");

            membersList.replaceChildren();

            heading.textContent = `Oda üyeleri (${snapshot.size})`;

            if (snapshot.empty) {
                const empty = document.createElement("p");
                empty.className = "empty-rooms";
                empty.textContent = "Bu odada henüz üye yok.";

                membersList.appendChild(empty);
                return;
            }

            const members = snapshot.docs.map(memberDoc => ({
                id: memberDoc.id,
                ...memberDoc.data()
            }));

            // Show room owner first, then sort by username.
            members.sort((a, b) => {
                if (a.role === "owner") return -1;
                if (b.role === "owner") return 1;

                return (a.username || "").localeCompare(
                    b.username || ""
                );
            });

            for (const member of members) {

                const item = document.createElement("div");
                item.className = "member-item";

                const info = document.createElement("div");
                info.className = "member-info";

                const username = document.createElement("strong");
                username.textContent = member.username || "Bilinmeyen kullanıcı";

                const role = document.createElement("span");
                role.textContent =
                    member.role === "owner" ? "Oda sahibi" : "Üye";

                info.append(username, role);
                item.appendChild(info);

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
        (snapshot) => {
            if (activeRoomId !== roomId || activeRoomOwnerId !== currentUser?.uid) {
                return;
            }

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

            snapshot.forEach((banDoc) => {
                const ban = banDoc.data();
                const item = document.createElement("div");
                item.className = "banned-user-item";

                const username = document.createElement("strong");
                username.textContent = ban.username || "Bilinmeyen kullanıcı";

                const button = document.createElement("button");
                button.type = "button";
                button.className = "unban-button";
                button.textContent = "Banı kaldır";
                button.addEventListener("click", () => {
                    unbanMember(banDoc.id, ban.username || "kullanıcı");
                });

                item.append(username, button);
                list.appendChild(item);
            });
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
                    username: member.username || "Bilinmeyen kullanıcı",
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

        const leaveButton = $("leaveRoomButton");
        leaveButton.disabled = false;
        leaveButton.classList.toggle("room-delete-button", isOwner);
        leaveButton.textContent = isOwner ? "Odayı sil" : "Odadan çık";
        leaveButton.title = isOwner
            ? "Odayı, üyelikleri, davet kodunu ve ban kayıtlarını kalıcı olarak siler."
            : "Bu odadan ayrıl.";

        // Show room
        $("dashboardView").hidden = true;
        $("roomView").hidden = false;

        // Start live member updates
        listenToMembers(roomId, room.ownerId);

    } catch (error) {
        showRoomMessage(showError(error));
    }
}

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
        const [membersSnapshot, bansSnapshot] = await Promise.all([
            getDocs(collection(db, "rooms", roomId, "members")),
            getDocs(collection(db, "rooms", roomId, "bans"))
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

        currentUsername = profileSnapshot.data().username;

        await loadRooms();

    } catch (error) {
        showRoomMessage(showError(error));
    }
});
