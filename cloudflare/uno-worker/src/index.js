import {
    authenticateFirebaseToken,
    getFirestoreDocument
} from "./firebase.js";
import { signTicket, verifyTicket } from "./ticket.js";
import { UnoRoom } from "./UnoRoom.js";
import { VampirKoyluRoom } from "./VampirKoyluRoom.js";

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

async function authorizeRoomUser(env, uid, roomId, round, gameId = "uno") {
    const [sessionDoc, memberDoc] = await Promise.all([
        getFirestoreDocument(env, "rooms/" + roomId + "/gameSessions/active"),
        getFirestoreDocument(env, "rooms/" + roomId + "/members/" + uid)
    ]);
    if (!memberDoc) throw new Error("Bu odanın üyesi değilsin.");
    if (!sessionDoc) throw new Error("Oyun lobisi bulunamadı.");

    const session = sessionDoc.data;
    if (
        session.gameId !== gameId ||
        Number(session.round) !== Number(round) ||
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

function getRoomStub(env, gameId, roomId, round) {
    const binding = gameId === "vampir-koylu" ? env.VAMPIR_KOYLU_ROOMS : env.UNO_ROOMS;
    if (!binding) throw new Error("Bu oyun için Durable Object bağlantısı bulunamadı.");
    const id = binding.idFromName(roomId + ":" + String(round));
    return binding.get(id);
}

async function issueTicket(request, env, url, origin, gameId) {
    const user = await authenticateFirebaseToken(getBearerToken(request), env);
    const body = await readJson(request);
    validateRoomRound(body.roomId, body.round);
    const access = await authorizeRoomUser(env, user.uid, body.roomId, body.round, gameId);
    const ticket = await signTicket({
        uid: user.uid,
        roomId: body.roomId,
        round: Number(body.round),
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
    if (!["quit", "returnToLobby", "reconcile"].includes(body.action)) {
        return json({ error: "Desteklenmeyen oyun işlemi." }, 400, origin);
    }
    const access = await authorizeRoomUser(env, user.uid, body.roomId, body.round, gameId);
    if (access.role !== "player") {
        return json({ error: "Bu işlem yalnızca maç oyuncularına açık." }, 403, origin);
    }

    const stub = getRoomStub(env, gameId, body.roomId, body.round);
    const response = await stub.fetch("https://" + gameId + "-room.internal/action", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-CACA-UID": user.uid,
            "X-CACA-ROLE": access.role,
            "X-CACA-ROOM-ID": body.roomId,
            "X-CACA-ROUND": String(body.round)
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
                const stub = getRoomStub(env, gameId, ticket.roomId, ticket.round);
                const internalRequest = new Request("https://" + gameId + "-room.internal/connect", {
                    method: "GET",
                    headers: {
                        Upgrade: "websocket",
                        "X-CACA-UID": ticket.uid,
                        "X-CACA-ROLE": ticket.role,
                        "X-CACA-ROOM-ID": ticket.roomId,
                        "X-CACA-ROUND": String(ticket.round)
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
