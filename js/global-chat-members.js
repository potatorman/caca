import { auth, db } from "./firebase.js";
import { AVATARS, DEFAULT_AVATAR_ID, setAvatarElement } from "./avatars.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
    collection,
    doc,
    getDoc,
    setDoc,
    deleteDoc,
    runTransaction,
    onSnapshot,
    query,
    orderBy,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const $ = (id) => document.getElementById(id);

let currentUser = null;
let globalModeOpen = false;
let optedIntoGlobalChat = false;
let membershipSyncPromise = null;
let unsubscribeMembers = null;
const profileUnsubscribers = new Map();
const profileCache = new Map();
let latestMemberDocs = [];
let renderVersion = 0;

function stopProfileListeners() {
    for (const unsubscribe of profileUnsubscribers.values()) unsubscribe();
    profileUnsubscribers.clear();
    profileCache.clear();
}

function stopMemberListener() {
    if (unsubscribeMembers) {
        unsubscribeMembers();
        unsubscribeMembers = null;
    }
    stopProfileListeners();
    latestMemberDocs = [];
    renderVersion += 1;
}

async function refreshOptInState() {
    if (!currentUser) {
        optedIntoGlobalChat = false;
        return false;
    }
    const profileSnapshot = await getDoc(doc(db, "users", currentUser.uid));
    optedIntoGlobalChat = profileSnapshot.exists() && profileSnapshot.data().globalChatOptIn === true;
    return optedIntoGlobalChat;
}

function ensureMembershipDocument() {
    if (!currentUser) return Promise.resolve();
    if (membershipSyncPromise) return membershipSyncPromise;

    const userId = currentUser.uid;
    membershipSyncPromise = (async () => {
        if (!(await refreshOptInState())) return;
        const memberRef = doc(db, "globalChatMembers", userId);
        await runTransaction(db, async (transaction) => {
            const memberSnapshot = await transaction.get(memberRef);
            if (!memberSnapshot.exists()) {
                transaction.set(memberRef, {
                    userId,
                    joinedAt: serverTimestamp()
                });
            }
        });
    })().finally(() => {
        membershipSyncPromise = null;
    });
    return membershipSyncPromise;
}

function filterGlobalMembers() {
    const list = $("globalMembersList");
    const search = $("globalMembersSearch");
    if (!list || !search) return;

    const term = search.value.trim().toLocaleLowerCase("tr");
    let visibleCount = 0;
    list.querySelectorAll(".member-item").forEach((item) => {
        const matches = !term || item.textContent.toLocaleLowerCase("tr").includes(term);
        item.hidden = !matches;
        if (matches) visibleCount += 1;
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
$("globalMembersSearch")?.addEventListener("input", filterGlobalMembers);

$("closeGlobalMembersButton")?.addEventListener("click", () => {
    $("roomChatLayout")?.classList.add("members-collapsed");
    $("membersToggleButton")?.setAttribute("aria-expanded", "false");
    if ($("membersToggleButton")) {
        $("membersToggleButton").innerHTML = 'Üyeleri göster <span aria-hidden="true">▥</span>';
    }
});

async function getMemberProfile(userId) {
    if (profileCache.has(userId)) return profileCache.get(userId);
    const request = getDoc(doc(db, "users", userId))
        .then((snapshot) => snapshot.exists() ? snapshot.data() : null)
        .catch((error) => {
            console.warn("CACA: Global member profile could not be read:", userId, error);
            return null;
        });
    profileCache.set(userId, request);
    return request;
}

async function renderGlobalMembers() {
    const list = $("globalMembersList");
    if (!list) return;
    const version = ++renderVersion;
    const members = await Promise.all(latestMemberDocs.map(async (memberDoc) => {
        const profile = await getMemberProfile(memberDoc.id);
        const username = profile?.username || "Bilinmeyen kullanıcı";
        return {
            id: memberDoc.id,
            profile,
            accountUsername: username,
            nickname: profile?.nickname || username,
            avatarId: AVATARS[profile?.avatarId] ? profile.avatarId : DEFAULT_AVATAR_ID,
            avatarData: profile?.avatarData || null
        };
    }));

    if (version !== renderVersion || !globalModeOpen) return;
    list.replaceChildren();
    $("globalMembersCount").textContent = String(members.length);
    if (!members.length) {
        const empty = document.createElement("p");
        empty.className = "empty-rooms";
        empty.textContent = "Henüz Global Chat'e katılan üye yok.";
        list.appendChild(empty);
        return;
    }

    members.sort((a, b) => a.nickname.localeCompare(b.nickname, "tr"));
    for (const member of members) {
        const item = document.createElement("div");
        item.className = "member-item";
        item.dataset.userId = member.id;

        const avatar = document.createElement("div");
        avatar.className = "member-avatar";
        setAvatarElement(avatar, member.avatarId, member.avatarData);

        const info = document.createElement("div");
        info.className = "member-info";
        const nameLine = document.createElement("div");
        nameLine.className = "member-name-line";
        const name = document.createElement("strong");
        name.className = "member-display-name";
        name.textContent = member.nickname;
        nameLine.appendChild(name);

        if (member.profile?.siteRole === "site_owner") {
            const ownerBadge = document.createElement("span");
            ownerBadge.className = "site-owner-message-badge";
            ownerBadge.textContent = "SITE OWNER";
            nameLine.appendChild(ownerBadge);
        }
        if (member.id === currentUser?.uid) {
            const selfBadge = document.createElement("span");
            selfBadge.className = "member-badge self-badge";
            selfBadge.textContent = "SEN";
            nameLine.appendChild(selfBadge);
        }

        const username = document.createElement("span");
        username.className = "member-account-username";
        username.textContent = "@" + member.accountUsername;
        username.hidden = member.accountUsername.toLowerCase() === member.nickname.toLowerCase();

        info.append(nameLine, username);
        item.append(avatar, info);
        list.appendChild(item);
    }
    filterGlobalMembers();
}

function listenToMembers() {
    if (unsubscribeMembers) unsubscribeMembers();
    const membersQuery = query(collection(db, "globalChatMembers"), orderBy("joinedAt", "asc"));
    unsubscribeMembers = onSnapshot(membersQuery, (snapshot) => {
        latestMemberDocs = snapshot.docs;
        const memberIds = new Set(snapshot.docs.map((memberDoc) => memberDoc.id));

        for (const [userId, unsubscribe] of profileUnsubscribers) {
            if (!memberIds.has(userId)) {
                unsubscribe();
                profileUnsubscribers.delete(userId);
                profileCache.delete(userId);
            }
        }

        for (const memberDoc of snapshot.docs) {
            const userId = memberDoc.id;
            if (profileUnsubscribers.has(userId)) continue;
            const unsubscribe = onSnapshot(doc(db, "users", userId), (profileSnapshot) => {
                const profile = profileSnapshot.exists() ? profileSnapshot.data() : null;
                profileCache.set(userId, Promise.resolve(profile));
                renderGlobalMembers();
                document.dispatchEvent(new CustomEvent("caca:global-member-profile-updated", {
                    detail: { userId, profile }
                }));
            }, (error) => console.warn("CACA: Global member profile listener failed:", userId, error));
            profileUnsubscribers.set(userId, unsubscribe);
        }
        renderGlobalMembers();
    }, (error) => {
        console.error("CACA: Global member list listener failed:", error);
        const status = $("chatStatus");
        if (status) status.textContent = "Global Chat üye listesi yüklenemedi: " + (error.message || "Bilinmeyen hata");
    });
}

async function openGlobalMembers() {
    globalModeOpen = true;
    try {
        if (!(await refreshOptInState())) {
            throw new Error("Global Chat üyeliği etkin değil.");
        }
        await ensureMembershipDocument();
        listenToMembers();
    } catch (error) {
        console.error("CACA: Could not open Global Chat member list:", error);
        const status = $("chatStatus");
        if (status) status.textContent = "Global Chat üyeleri yüklenemedi: " + (error.message || "Bilinmeyen hata");
    }
}

function closeGlobalMembers() {
    globalModeOpen = false;
    stopMemberListener();
}

async function leaveGlobalMembers() {
    closeGlobalMembers();
    if (!currentUser) return;
    try {
        await deleteDoc(doc(db, "globalChatMembers", currentUser.uid));
    } catch (error) {
        console.error("CACA: Global Chat membership document could not be removed:", error);
    }
}

document.addEventListener("caca:global-chat-open", openGlobalMembers);
document.addEventListener("caca:global-chat-close", closeGlobalMembers);
document.addEventListener("caca:global-chat-leave", leaveGlobalMembers);
document.addEventListener("caca:refresh-global-members", renderGlobalMembers);

onAuthStateChanged(auth, async (user) => {
    closeGlobalMembers();
    currentUser = user || null;
    membershipSyncPromise = null;
    optedIntoGlobalChat = false;
    if (!currentUser) return;
    try {
        if (await refreshOptInState()) await ensureMembershipDocument();
    } catch (error) {
        console.warn("CACA: Existing Global Chat membership could not be restored:", error);
    }
});
