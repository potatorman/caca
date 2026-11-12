import {
    authenticateFirebaseToken,
    getFirestoreDocument
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
                /üyesi|oyuncusu|izleyicisi|açık/i.test(message) ? 403 : 400;
            return json({ error: message }, status, origin);
        }
    }
};
