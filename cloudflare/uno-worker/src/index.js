import {
    authenticateFirebaseToken,
    getFirestoreDocument,
    patchFirestoreDocument,
    createFirestoreDocument,
    deleteFirestoreDocument,
    listFirestoreDocuments,
    listFirestoreCollectionIds,
    getGoogleAccessToken,
    firestoreTimestamp
} from "./firebase.js";
import { signTicket, verifyTicket } from "./ticket.js";
import { UnoRoom } from "./UnoRoom.js";
import { VampirKoyluRoom } from "./VampirKoyluRoom.js";
import { getUnoDurableObjectName, getVampirKoyluDurableObjectName, isValidVampirKoyluSessionId } from "./session-identity.js";

export { UnoRoom, VampirKoyluRoom };

const jsonHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
};

function json(data, status = 200, origin = "*") {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            ...jsonHeaders,
            "Access-Control-Allow-Origin": origin || "*",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Vary": "Origin"
        }
    });
}

function getBearerToken(request) {
    const header = request.headers.get("Authorization") || "";
    return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function validateSessionId(sessionId) {
    if (!isValidVampirKoyluSessionId(sessionId)) {
        throw new Error("Vampir Köylü oturum kimliği geçersiz.");
    }
}

function validateLobbyId(lobbyId) {
    if (typeof lobbyId !== "string" || (lobbyId !== "active" && !/^[A-Za-z0-9_-]{16,80}$/.test(lobbyId))) throw new Error("Oyun lobisi kimliği geçersiz.");
}

function validateRoomRound(roomId, round) {
    if (
        typeof roomId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(roomId) ||
        !Number.isInteger(Number(round)) ||
        Number(round) < 1
    ) {
        throw new Error("Oda veya tur bilgisi geçersiz.");
    }
}

function sessionPlayers(session) {
    return Array.isArray(session.matchPlayerIds)
        ? session.matchPlayerIds
        : (["playing", "results"].includes(session.status) ? session.playerIds || [] : []);
}

async function authorizeRoomUser(env, uid, roomId, lobbyId, round, gameId = "uno", sessionId = null) {
    const [sessionDoc, memberDoc] = await Promise.all([
        getFirestoreDocument(env, "rooms/" + roomId + "/gameSessions/" + lobbyId),
        roomId === "global" ? Promise.resolve({ uid }) : getFirestoreDocument(env, "rooms/" + roomId + "/members/" + uid)
    ]);
    if (!memberDoc) throw new Error("Bu odanın üyesi değilsin.");
    if (!sessionDoc) throw new Error("Oyun lobisi bulunamadı.");

    const session = sessionDoc.data;
    if (
        session.gameId !== gameId ||
        Number(session.round) !== Number(round) ||
        (gameId === "vampir-koylu" && session.sessionId !== sessionId) ||
        !["playing", "results"].includes(session.status)
    ) {
        throw new Error("Bu oyun turu artık aktif değil.");
    }

    const players = sessionPlayers(session);
    const spectators = Array.isArray(session.spectatorIds) ? session.spectatorIds : [];
    if (!players.includes(uid) && !spectators.includes(uid)) {
        throw new Error("Bu maçın oyuncusu veya izleyicisi değilsin.");
    }
    return {
        session,
        role: players.includes(uid) ? "player" : "spectator"
    };
}

function getRoomStub(env, gameId, roomId, lobbyId, round, sessionId = null) {
    const binding = gameId === "vampir-koylu" ? env.VAMPIR_KOYLU_ROOMS : env.UNO_ROOMS;
    if (!binding) throw new Error("Bu oyun için Durable Object bağlantısı bulunamadı.");
    const identity = gameId === "vampir-koylu"
        ? getVampirKoyluDurableObjectName(roomId, lobbyId, round, sessionId)
        : getUnoDurableObjectName(roomId, lobbyId, round);
    const id = binding.idFromName(identity);
    return binding.get(id);
}

async function issueTicket(request, env, url, origin, gameId) {
    const user = await authenticateFirebaseToken(getBearerToken(request), env);
    const body = await readJson(request);
    validateRoomRound(body.roomId, body.round);
    validateLobbyId(body.lobbyId);
    if (gameId === "vampir-koylu") validateSessionId(body.sessionId);
    const access = await authorizeRoomUser(env, user.uid, body.roomId, body.lobbyId, body.round, gameId, body.sessionId);
    const ticket = await signTicket({
        uid: user.uid,
        roomId: body.roomId,
        lobbyId: body.lobbyId,
        round: Number(body.round),
        ...(gameId === "vampir-koylu" ? { sessionId: body.sessionId } : {}),
        role: access.role,
        gameId,
        exp: Math.floor(Date.now() / 1000) + 120
    }, env.CACA_TICKET_SECRET);

    return json({
        ticket,
        webSocketUrl: "wss://" + url.host + "/ws?ticket=" + encodeURIComponent(ticket)
    }, 200, origin);
}

async function sendHttpAction(request, env, origin, gameId) {
    const user = await authenticateFirebaseToken(getBearerToken(request), env);
    const body = await readJson(request);
    validateRoomRound(body.roomId, body.round);
    validateLobbyId(body.lobbyId);
    if (!["quit", "returnToLobby", "reconcile"].includes(body.action)) {
        return json({ error: "Desteklenmeyen oyun işlemi." }, 400, origin);
    }
    if (gameId === "vampir-koylu") validateSessionId(body.sessionId);
    const access = await authorizeRoomUser(env, user.uid, body.roomId, body.lobbyId, body.round, gameId, body.sessionId);
    if (access.role !== "player") {
        return json({ error: "Bu işlem yalnızca maç oyuncularına açık." }, 403, origin);
    }

    const stub = getRoomStub(env, gameId, body.roomId, body.lobbyId, body.round, body.sessionId);
    const response = await stub.fetch("https://" + gameId + "-room.internal/action", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-CACA-UID": user.uid,
            "X-CACA-ROLE": access.role,
            "X-CACA-ROOM-ID": body.roomId,
            "X-CACA-LOBBY-ID": body.lobbyId,
            "X-CACA-ROUND": String(body.round),
            ...(gameId === "vampir-koylu" ? { "X-CACA-SESSION-ID": body.sessionId } : {})
        },
        body: JSON.stringify({ action: body.action })
    });
    const payload = await response.json().catch(() => ({}));
    return json(payload, response.status, origin);
}


const PASSWORD_ITERATIONS = 210000;
const encoder = new TextEncoder();
function base64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}
function fromBase64(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function deriveLobbyPassword(password, salt) {
    const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PASSWORD_ITERATIONS }, material, 256);
    return new Uint8Array(bits);
}
function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
    return diff === 0;
}
async function manageLobby(request, env, origin) {
    const user = await authenticateFirebaseToken(getBearerToken(request), env);
    const body = await readJson(request);
    validateLobbyId(body.lobbyId);
    const path = "rooms/global/gameSessions/" + body.lobbyId;
    const lobbyDoc = await getFirestoreDocument(env, path);
    if (!lobbyDoc) return json({ error: "Oyun lobisi bulunamadı." }, 404, origin);
    const lobby = lobbyDoc.data;
    const secretPath = "rooms/global/lobbySecrets/" + body.lobbyId;
    if (body.action === "set-password") {
        if (lobby.hostId !== user.uid || lobby.status !== "lobby") return json({ error: "Yalnızca açık lobinin sahibi parola ayarlayabilir." }, 403, origin);
        const password = String(body.password || "");
        if (password && (password.length < 4 || password.length > 64)) return json({ error: "Lobi parolası 4–64 karakter olmalı." }, 400, origin);
        if (!password) {
            await deleteFirestoreDocument(env, secretPath);
            await patchFirestoreDocument(env, path, { hasPassword: false });
            return json({ ok: true, hasPassword: false }, 200, origin);
        }
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const verifier = await deriveLobbyPassword(password, salt);
        await patchFirestoreDocument(env, secretPath, {
            salt: base64(salt), verifier: base64(verifier), iterations: PASSWORD_ITERATIONS,
            updatedAt: firestoreTimestamp()
        });
        await patchFirestoreDocument(env, path, { hasPassword: true });
        return json({ ok: true, hasPassword: true }, 200, origin);
    }
    if (body.action === "join") {
        if (!['lobby', 'results'].includes(lobby.status)) return json({ error: "Bu lobiye şu anda katılınamıyor." }, 409, origin);
        if (lobby.hostId === user.uid || (lobby.playerIds || []).includes(user.uid) || (lobby.nextRoundPlayerIds || []).includes(user.uid)) return json({ ok: true, alreadyJoined: true }, 200, origin);
        if (lobby.hasPassword) {
            const secret = await getFirestoreDocument(env, secretPath);
            if (!secret || !body.password) return json({ error: "Lobi parolası yanlış." }, 403, origin);
            const candidate = await deriveLobbyPassword(String(body.password), fromBase64(secret.data.salt));
            if (!constantTimeEqual(candidate, fromBase64(secret.data.verifier))) return json({ error: "Lobi parolası yanlış." }, 403, origin);
        }
        const field = lobby.status === "results" ? "nextRoundPlayerIds" : "playerIds";
        const existing = Array.isArray(lobby[field]) ? lobby[field] : [];
        const occupied = (lobby.playerIds || []).length + (lobby.spectatorIds || []).length + (lobby.nextRoundPlayerIds || []).length;
        const max = Number(lobby.maxPlayers) || 10;
        if (occupied >= max) return json({ error: "Lobi dolu." }, 409, origin);
        await patchFirestoreDocument(env, path, { [field]: [...existing, user.uid], updatedAt: new Date().toISOString() });
        return json({ ok: true, joined: true }, 200, origin);
    }
    return json({ error: "Desteklenmeyen lobi işlemi." }, 400, origin);
}

async function isSiteOwnerUid(env, uid) {
    const [membership, legacyOwner] = await Promise.all([
        getFirestoreDocument(env, "siteConfig/siteOwners/" + uid),
        getFirestoreDocument(env, "siteConfig/siteOwner")
    ]);
    return Boolean(membership || legacyOwner?.data.uid === uid);
}

async function claimSiteOwner(request, env, origin) {
    const user = await authenticateFirebaseToken(getBearerToken(request), env);
    const ownerPath = "siteConfig/siteOwners/" + user.uid;

    // Existing owners can safely retry a partially completed activation.
    if (await isSiteOwnerUid(env, user.uid)) {
        await patchFirestoreDocument(env, "users/" + user.uid, {
            siteRole: "site_owner",
            siteOwnerClaimedAt: firestoreTimestamp()
        });
        return json({ ok: true, role: "site_owner", alreadyOwner: true }, 200, origin);
    }

    const body = await readJson(request);
    const suppliedCode = typeof body.setupCode === "string" ? body.setupCode : "";
    const configuredCode = typeof env.CACA_SITE_OWNER_SETUP_CODE === "string"
        ? env.CACA_SITE_OWNER_SETUP_CODE
        : "";

    if (!configuredCode) {
        return json({ error: "Site Owner kurulum kodu Worker secret olarak ayarlanmamış." }, 503, origin);
    }
    if (
        !/^[A-Za-z0-9_-]{32}$/.test(configuredCode) ||
        !/^[A-Za-z0-9_-]{32}$/.test(suppliedCode) ||
        !constantTimeEqual(encoder.encode(suppliedCode), encoder.encode(configuredCode))
    ) {
        return json({ error: "32 karakterli Site Owner kurulum kodu yanlış." }, 403, origin);
    }

    // Store only a SHA-256 digest so each generated secret can be redeemed once.
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(suppliedCode)));
    const codeHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const usedCodePath = "siteConfig/usedOwnerSetupCodes/" + codeHash;
    const usedCode = await getFirestoreDocument(env, usedCodePath);
    if (usedCode && usedCode.data.uid !== user.uid) {
        return json({ error: "Bu kurulum kodu daha önce kullanılmış. Yeni bir kod üret." }, 409, origin);
    }
    if (!usedCode) {
        try {
            await createFirestoreDocument(env, usedCodePath, {
                uid: user.uid,
                usedAt: firestoreTimestamp()
            });
        } catch {
            const redeemed = await getFirestoreDocument(env, usedCodePath);
            if (!redeemed || redeemed.data.uid !== user.uid) {
                return json({ error: "Bu kurulum kodu aynı anda başka bir hesap tarafından kullanıldı." }, 409, origin);
            }
        }
    }

    try {
        await createFirestoreDocument(env, ownerPath, {
            uid: user.uid,
            grantedAt: firestoreTimestamp(),
            grantedBy: "one_time_setup_code"
        });
    } catch {
        const existingMembership = await getFirestoreDocument(env, ownerPath);
        if (!existingMembership) throw new Error("Site Owner yetkisi kaydedilemedi. Aynı kodla tekrar dene.");
    }

    await patchFirestoreDocument(env, "users/" + user.uid, {
        siteRole: "site_owner",
        siteOwnerClaimedAt: firestoreTimestamp()
    });
    return json({ ok: true, role: "site_owner" }, 200, origin);
}

async function deleteFirestoreDocumentTree(env, documentPath, depth = 0) {
    if (depth > 12) throw new Error("Hesap verilerinde beklenenden fazla alt koleksiyon bulundu.");
    const collectionIds = await listFirestoreCollectionIds(env, documentPath);
    for (const collectionId of collectionIds) {
        const collectionPath = documentPath + "/" + collectionId;
        const documents = await listFirestoreDocuments(env, collectionPath);
        for (const child of documents) {
            const childPath = collectionPath + "/" + child.id;
            await deleteFirestoreDocumentTree(env, childPath, depth + 1);
            await deleteFirestoreDocument(env, childPath);
        }
    }
}

async function deleteFirebaseAuthAccount(env, uid) {
    const accessToken = await getGoogleAccessToken(env);
    const response = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:delete", {
        method: "POST",
        headers: {
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            localId: uid,
            targetProjectId: env.FIREBASE_PROJECT_ID
        })
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok || /USER_NOT_FOUND/i.test(payload.error?.message || "")) return;

    const reason = payload.error?.message || response.statusText;
    if (response.status === 403 || /PERMISSION_DENIED|insufficient.*permission/i.test(reason)) {
        throw new Error(
            "Firebase service account hesabı silemiyor. Google Cloud Console'da FIREBASE_SERVICE_ACCOUNT_JSON içindeki service account'a Firebase Authentication Admin rolünü (firebaseauth.users.delete) ver."
        );
    }
    throw new Error("Firebase Authentication hesabı silinemedi: " + reason);
}

async function deleteUserFirestoreData(env, uid) {
    const rooms = await listFirestoreDocuments(env, "rooms");

    for (const roomDocument of rooms) {
        const roomPath = "rooms/" + roomDocument.id;
        const room = roomDocument.data || {};

        if (room.ownerId === uid) {
            if (typeof room.inviteCode === "string" && room.inviteCode) {
                await deleteFirestoreDocument(env, "roomInvites/" + room.inviteCode);
            }
            await deleteFirestoreDocumentTree(env, roomPath);
            await deleteFirestoreDocument(env, roomPath);
            continue;
        }

        // Remove this account from every room it joined, plus its private prank inbox.
        await deleteFirestoreDocument(env, roomPath + "/members/" + uid);
        await deleteFirestoreDocument(env, roomPath + "/prankInbox/" + uid);
        await deleteFirestoreDocument(env, roomPath + "/bans/" + uid);

        // Remove messages authored by the deleted account from surviving rooms.
        const roomMessages = await listFirestoreDocuments(env, roomPath + "/messages");
        for (const message of roomMessages) {
            if (message.data.senderId === uid) {
                const messagePath = roomPath + "/messages/" + message.id;
                await deleteFirestoreDocumentTree(env, messagePath);
                await deleteFirestoreDocument(env, messagePath);
            }
        }

        // Remove the deleted account from any active game session in this room.
        const sessions = await listFirestoreDocuments(env, roomPath + "/gameSessions");
        for (const session of sessions) {
            const sessionPath = roomPath + "/gameSessions/" + session.id;
            if (session.data.hostId === uid) {
                await deleteFirestoreDocumentTree(env, sessionPath);
                await deleteFirestoreDocument(env, sessionPath);
                continue;
            }

            const updates = {};
            for (const field of [
                "playerIds", "matchPlayerIds", "nextRoundPlayerIds",
                "spectatorIds", "readyPlayerIds", "alivePlayerIds", "votedPlayerIds"
            ]) {
                if (Array.isArray(session.data[field]) && session.data[field].includes(uid)) {
                    updates[field] = session.data[field].filter((playerId) => playerId !== uid);
                }
            }
            for (const field of ["players", "playerProfiles", "playerStates", "handCounts"]) {
                const value = session.data[field];
                if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, uid)) {
                    updates[field] = Object.fromEntries(
                        Object.entries(value).filter(([playerId]) => playerId !== uid)
                    );
                }
            }
            await deleteFirestoreDocumentTree(env, sessionPath + "/hands/" + uid);
            await deleteFirestoreDocument(env, sessionPath + "/hands/" + uid);
            if (Object.keys(updates).length) {
                await patchFirestoreDocument(env, sessionPath, updates);
            }
        }
    }

    const globalMessages = await listFirestoreDocuments(env, "globalChatMessages");
    for (const message of globalMessages) {
        if (message.data.senderId === uid) {
            const messagePath = "globalChatMessages/" + message.id;
            await deleteFirestoreDocumentTree(env, messagePath);
            await deleteFirestoreDocument(env, messagePath);
        }
    }

    await deleteFirestoreDocument(env, "globalChatMembers/" + uid);
    await deleteFirestoreDocumentTree(env, "users/" + uid);
    await deleteFirestoreDocument(env, "users/" + uid);
}

async function deleteSiteOwnerRoom(request, env, origin) {
    const owner = await authenticateFirebaseToken(getBearerToken(request), env);
    if (!(await isSiteOwnerUid(env, owner.uid))) {
        return json({ error: "Bu işlem için Site Owner yetkisi gerekli." }, 403, origin);
    }

    const body = await readJson(request);
    const roomId = typeof body.roomId === "string" ? body.roomId : "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(roomId) || roomId === "global") {
        return json({ error: "Silinecek özel oda kimliği geçersiz." }, 400, origin);
    }

    const roomPath = "rooms/" + roomId;
    const roomDocument = await getFirestoreDocument(env, roomPath);
    if (!roomDocument) {
        return json({ error: "Bu özel oda zaten silinmiş veya bulunamadı." }, 404, origin);
    }

    // Remove invite lookup first, then recursively remove every room subcollection
    // (members, messages, game sessions, bans, inboxes, and nested game data).
    const inviteCode = roomDocument.data.inviteCode;
    if (typeof inviteCode === "string" && inviteCode) {
        await deleteFirestoreDocument(env, "roomInvites/" + inviteCode);
    }

    // Remove each user's private room-list entry so deleted rooms disappear everywhere.
    const users = await listFirestoreDocuments(env, "users");
    for (const user of users) {
        await deleteFirestoreDocument(env, "users/" + user.id + "/rooms/" + roomId);
    }

    await deleteFirestoreDocumentTree(env, roomPath);
    await deleteFirestoreDocument(env, roomPath);

    return json({ ok: true, roomId }, 200, origin);
}

async function deleteSiteUserAccount(request, env, origin) {
    const owner = await authenticateFirebaseToken(getBearerToken(request), env);
    if (!(await isSiteOwnerUid(env, owner.uid))) {
        return json({ error: "Bu işlem için Site Owner yetkisi gerekli." }, 403, origin);
    }

    const body = await readJson(request);
    const suppliedUids = Array.isArray(body.uids)
        ? body.uids
        : (typeof body.uid === "string" ? [body.uid] : []);
    const targetUids = [...new Set(suppliedUids)];
    if (!targetUids.length) {
        return json({ error: "Silinecek kullanıcı seçilmedi." }, 400, origin);
    }
    if (targetUids.length > 25) {
        return json({ error: "Tek istekte en fazla 25 hesap silebilirsin." }, 400, origin);
    }
    if (targetUids.some((uid) => typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(uid))) {
        return json({ error: "Silinecek kullanıcı kimliklerinden biri geçersiz." }, 400, origin);
    }

    const deletedUids = [];
    const failed = [];
    for (const targetUid of targetUids) {
        if (targetUid === owner.uid) {
            failed.push({ uid: targetUid, error: "Kendi Site Owner hesabını silemezsin." });
            continue;
        }
        try {
            if (await isSiteOwnerUid(env, targetUid)) {
                failed.push({ uid: targetUid, error: "Site Owner hesapları bu listeden silinemez." });
                continue;
            }

            // Authentication is deleted first. Retrying after a partial cleanup
            // is safe because USER_NOT_FOUND is treated as already deleted.
            await deleteFirebaseAuthAccount(env, targetUid);
            await deleteUserFirestoreData(env, targetUid);
            deletedUids.push(targetUid);
        } catch (error) {
            console.error("CACA owner account deletion failed for UID:", targetUid, error);
            failed.push({
                uid: targetUid,
                error: error?.message || "Hesap silinemedi."
            });
        }
    }

    return json({
        ok: failed.length === 0,
        deletedUids,
        failed
    }, 200, origin);
}

async function readJson(request) {
    try {
        return await request.json();
    } catch {
        throw new Error("İstek verisi geçersiz.");
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get("Origin") || "*";

        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: {
                    "Access-Control-Allow-Origin": origin,
                    "Access-Control-Allow-Headers": "Authorization, Content-Type",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Max-Age": "86400",
                    "Vary": "Origin"
                }
            });
        }

        try {
            if (url.pathname === "/health" && request.method === "GET") {
                return json({ ok: true, service: "caca-uno", version: 2 }, 200, origin);
            }

            if (url.pathname === "/api/lobby/manage" && request.method === "POST") {
                return await manageLobby(request, env, origin);
            }
            if (url.pathname === "/api/site-owner/claim" && request.method === "POST") {
                return await claimSiteOwner(request, env, origin);
            }
            if (url.pathname === "/api/site-owner/delete-room" && request.method === "POST") {
                return await deleteSiteOwnerRoom(request, env, origin);
            }
            if (url.pathname === "/api/site-owner/delete-user" && request.method === "POST") {
                return await deleteSiteUserAccount(request, env, origin);
            }
            if (url.pathname === "/api/uno/ticket" && request.method === "POST") {
                return await issueTicket(request, env, url, origin, "uno");
            }
            if (url.pathname === "/api/vampir-koylu/ticket" && request.method === "POST") {
                return await issueTicket(request, env, url, origin, "vampir-koylu");
            }
            if (url.pathname === "/api/uno/action" && request.method === "POST") {
                return await sendHttpAction(request, env, origin, "uno");
            }
            if (url.pathname === "/api/vampir-koylu/action" && request.method === "POST") {
                return await sendHttpAction(request, env, origin, "vampir-koylu");
            }

            if (url.pathname === "/ws" && request.method === "GET") {
                if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
                    return json({ error: "WebSocket bağlantısı gerekli." }, 426, origin);
                }
                const ticket = await verifyTicket(url.searchParams.get("ticket"), env.CACA_TICKET_SECRET);
                const gameId = ticket.gameId === "vampir-koylu" ? "vampir-koylu" : "uno";
                if (gameId === "vampir-koylu") validateSessionId(ticket.sessionId);
                validateLobbyId(ticket.lobbyId);
                const stub = getRoomStub(env, gameId, ticket.roomId, ticket.lobbyId, ticket.round, ticket.sessionId);
                const internalRequest = new Request("https://" + gameId + "-room.internal/connect", {
                    method: "GET",
                    headers: {
                        Upgrade: "websocket",
                        "X-CACA-UID": ticket.uid,
                        "X-CACA-ROLE": ticket.role,
                        "X-CACA-ROOM-ID": ticket.roomId,
                        "X-CACA-LOBBY-ID": ticket.lobbyId,
                        "X-CACA-ROUND": String(ticket.round),
                        ...(gameId === "vampir-koylu" ? { "X-CACA-SESSION-ID": ticket.sessionId } : {})
                    }
                });
                return await stub.fetch(internalRequest);
            }

            return json({ error: "CACA UNO endpoint bulunamadı." }, 404, origin);
        } catch (error) {
            const message = error?.message || "Beklenmeyen sunucu hatası.";
            const status = /token|oturum|bileti/i.test(message) ? 401 :
                /yetki|izin|permission|silemiyor|üyesi|oyuncusu|izleyicisi|açık/i.test(message) ? 403 : 400;
            return json({ error: message }, status, origin);
        }
    }
};
