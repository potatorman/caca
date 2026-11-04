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
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

let currentUser = null;
let currentUsername = "";
let activeRoomCode = "";
let unsubscribeMembers = null;

const roomChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateRoomCode() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);

    return Array.from(bytes, byte => roomChars[byte % roomChars.length]).join("");
}

function showRoomMessage(message, success = false) {
    const element = $("roomMessage");

    element.textContent = message;
    element.className = "status-message";

    if (success) {
        element.classList.add("success");
    }
}

function showError(error) {
    console.error(error);

    if (error.code === "permission-denied") {
        return "Firebase güvenlik kuralları işlemi reddetti. Firestore Rules bölümünü kontrol et.";
    }

    if (error.code === "unavailable") {
        return "İnternet bağlantısını kontrol et.";
    }

    return error.message || "Bir hata oluştu.";
}

// LOAD USER'S ROOMS
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

        const rooms = snapshot.docs.map(roomDoc => ({
            id: roomDoc.id,
            ...roomDoc.data()
        }));

        for (const room of rooms) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "room-list-item";

            const info = document.createElement("div");

            const name = document.createElement("strong");
            name.textContent = room.name;

            const role = document.createElement("span");
            role.textContent = room.role === "owner"
                ? "Oda sahibi"
                : "Üye";

            info.append(name, role);

            const arrow = document.createElement("span");
            arrow.textContent = "→";

            button.append(info, arrow);

            button.addEventListener("click", () => {
                openRoom(room.id);
            });

            roomsList.appendChild(button);
        }

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

        // Main room document
        batch.set(roomRef, {
            name: name,
            ownerId: currentUser.uid,
            inviteCode: code,
            createdAt: serverTimestamp()
        });

        // Private invite-code lookup
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
        // Find room using its invite code
        const inviteSnapshot = await getDoc(
            doc(db, "roomInvites", code)
        );

        if (!inviteSnapshot.exists()) {
            throw new Error("Bu davet koduyla bir oda bulunamadı.");
        }

        const invite = inviteSnapshot.data();
        const roomId = invite.roomId;

        // Prevent duplicate membership
        const ownRoomRef = doc(
            db, "users", currentUser.uid, "rooms", roomId
        );

        const existingRoom = await getDoc(ownRoomRef);

        if (existingRoom.exists()) {
            throw new Error("Bu odaya zaten katılmışsın.");
        }

        const batch = writeBatch(db);

        // Add user to room
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

// OPEN ROOM
async function openRoom(roomId) {
    if (!currentUser) return;

    try {
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

        // Stop listening to the previous room
if (unsubscribeMembers) {
    unsubscribeMembers();
    unsubscribeMembers = null;
}

// Listen for real-time member changes
unsubscribeMembers = onSnapshot(
    collection(db, "rooms", roomId, "members"),

    (snapshot) => {
        const membersList = $("membersList");
        membersList.replaceChildren();

        snapshot.forEach((memberDoc) => {
            const member = memberDoc.data();

            const item = document.createElement("div");
            item.className = "member-item";

            const username = document.createElement("strong");
            username.textContent = member.username;

            const role = document.createElement("span");
            role.textContent = member.role === "owner"
                ? "Oda sahibi"
                : "Üye";

            item.append(username, role);
            membersList.appendChild(item);
        });
    },

    (error) => {
        console.error("Member listener error:", error);
        showRoomMessage(showError(error));
    }
);

        $("dashboardView").hidden = true;
        $("roomView").hidden = false;

    } catch (error) {
        showRoomMessage(showError(error));
    }
}

// BACK TO DASHBOARD
$("backToDashboard").addEventListener("click", () => {

    if (unsubscribeMembers) {
        unsubscribeMembers();
        unsubscribeMembers = null;
    }

    $("roomView").hidden = true;
    $("dashboardView").hidden = false;

    loadRooms();
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
    currentUser = user;

    document.body.classList.toggle("logged-in", !!user);

    if (!user) {
        currentUsername = "";
        $("roomsList").replaceChildren();
        $("roomCount").textContent = "0 oda";
        return;
    }

    try {
        // Load the saved username
        const profileSnapshot = await getDoc(
            doc(db, "users", user.uid)
        );

        currentUsername = profileSnapshot.exists()
            ? profileSnapshot.data().username
            : user.email.split("@")[0];

        await loadRooms();

    } catch (error) {
        showRoomMessage(showError(error));
    }
});
