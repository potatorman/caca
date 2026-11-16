import { DurableObject } from "cloudflare:workers";
import {
    advancePuzzleRound,
    allPlayersAnswered,
    applyPuzzleAnswer,
    createPuzzleMatch,
    MAX_PUZZLE_PLAYERS,
    MIN_PUZZLE_PLAYERS,
    QUESTION_TIME_MS,
    REVEAL_TIME_MS,
    revealPuzzleRound
} from "../../../games/puzzle/engine.js";
import { getPublicQuestion, PUZZLE_GAME_IDS } from "../../../games/puzzle/questions.js";
import {
    deleteFirestoreDocument,
    firestoreTimestamp,
    getFirestoreDocument,
    patchFirestoreDocument
} from "./firebase.js";

function uniqueIds(values) {
    return [...new Set(Array.isArray(values)
        ? values.filter((value) => typeof value === "string" && value)
        : [])];
}

function getSessionPath(identity) {
    return "rooms/" + identity.roomId + "/gameSessions/" + identity.lobbyId;
}

function timestampNow(value = Date.now()) {
    return firestoreTimestamp(new Date(value));
}

function publicState(match, uid, connectedIds) {
    const questionIndex = match.questionOrder[match.roundIndex];
    const question = getPublicQuestion(match.gameId, questionIndex);
    const reveal = match.phase !== "question";
    return {
        roomId: match.roomId,
        lobbyId: match.lobbyId,
        round: match.round,
        gameId: match.gameId,
        status: match.status,
        phase: match.phase,
        playerIds: [...match.playerIds],
        activePlayerIds: [...match.activePlayerIds],
        roundNumber: match.roundIndex + 1,
        totalRounds: match.questionOrder.length,
        phaseStartedAt: match.phaseStartedAt,
        phaseEndsAt: match.phaseEndsAt,
        question,
        submittedPlayerIds: match.activePlayerIds.filter((id) => Boolean(match.answers[id])),
        myAnswerIndex: match.answers[uid]?.optionIndex ?? null,
        correctAnswerIndex: reveal ? match.revealedAnswer : null,
        explanation: reveal ? match.explanation || "" : "",
        roundAwards: reveal ? { ...match.roundAwards } : {},
        winnerIds: [...(match.winnerIds || [])],
        finishedAt: match.finishedAt,
        scoreboard: match.playerIds.map((id) => ({
            uid: id,
            score: Number(match.scores[id]) || 0,
            streak: Number(match.streaks[id]) || 0,
            roundPoints: reveal ? Number(match.roundAwards[id]) || 0 : null,
            answered: Boolean(match.answers[id]),
            online: connectedIds.has(id)
        })).sort((a, b) => b.score - a.score || match.playerIds.indexOf(a.uid) - match.playerIds.indexOf(b.uid))
    };
}

export class PuzzleRoom extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.ctx = ctx;
        this.env = env;
        this.actionQueue = Promise.resolve();
    }

    enqueue(task) {
        const operation = this.actionQueue.then(task, task);
        this.actionQueue = operation.catch(() => {});
        return operation;
    }

    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/connect" && request.method === "GET") {
            return this.enqueue(() => this.acceptConnection(request));
        }
        if (url.pathname === "/action" && request.method === "POST") {
            return this.enqueue(() => this.handleHttpAction(request));
        }
        return new Response("Not found", { status: 404 });
    }

    async setIdentity(headers) {
        const identity = {
            roomId: headers.get("X-CACA-ROOM-ID") || "",
            lobbyId: headers.get("X-CACA-LOBBY-ID") || "",
            round: Number(headers.get("X-CACA-ROUND")),
            gameId: headers.get("X-CACA-GAME-ID") || ""
        };
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(identity.roomId) ||
            (identity.lobbyId !== "active" && !/^[A-Za-z0-9_-]{16,80}$/.test(identity.lobbyId)) ||
            !Number.isInteger(identity.round) || identity.round < 1 ||
            !PUZZLE_GAME_IDS.includes(identity.gameId)) {
            throw new Error("Bulmaca odası veya tur bilgisi geçersiz.");
        }
        const current = await this.ctx.storage.get("identity");
        if (current && (
            current.roomId !== identity.roomId ||
            current.lobbyId !== identity.lobbyId ||
            current.round !== identity.round ||
            current.gameId !== identity.gameId
        )) {
            throw new Error("Bulmaca kimliği bu oyun odasıyla eşleşmiyor.");
        }
        await this.ctx.storage.put("identity", identity);
        return identity;
    }

    async getIdentity() {
        const identity = await this.ctx.storage.get("identity");
        if (!identity) throw new Error("Bulmaca odası henüz başlatılmadı.");
        return identity;
    }

    async loadMatch(createIfMissing = true) {
        const existing = await this.ctx.storage.get("match");
        if (existing || !createIfMissing) return existing || null;

        const identity = await this.getIdentity();
        const sessionDoc = await getFirestoreDocument(this.env, getSessionPath(identity));
        if (!sessionDoc) throw new Error("Firebase oyun lobisi bulunamadı.");
        const session = sessionDoc.data;
        if (session.gameId !== identity.gameId ||
            Number(session.round) !== identity.round ||
            !["playing", "results"].includes(session.status)) {
            throw new Error("Bulmaca maçı başlatılmaya hazır değil.");
        }

        const players = uniqueIds(session.matchPlayerIds || session.playerIds);
        if (players.length < MIN_PUZZLE_PLAYERS || players.length > MAX_PUZZLE_PLAYERS) {
            throw new Error("Bu oyun 2–8 aktif oyuncu gerektirir.");
        }
        const match = createPuzzleMatch({
            ...identity,
            playerIds: players,
            now: Date.now()
        });
        await this.ctx.storage.put("match", match);
        await this.scheduleAlarm(match);
        return match;
    }

    connectedPlayerIds() {
        const connected = new Set();
        for (const socket of this.ctx.getWebSockets()) {
            const attachment = socket.deserializeAttachment();
            if (attachment?.role === "player" && attachment.uid) connected.add(attachment.uid);
        }
        return connected;
    }

    send(socket, payload) {
        try {
            socket.send(JSON.stringify(payload));
        } catch {
            // Durable Objects remove closed sockets through their close event.
        }
    }

    sendSnapshot(socket, match) {
        const attachment = socket.deserializeAttachment();
        this.send(socket, {
            type: "state",
            state: publicState(match, attachment?.uid, this.connectedPlayerIds())
        });
    }

    broadcastState(match) {
        const connectedIds = this.connectedPlayerIds();
        for (const socket of this.ctx.getWebSockets()) {
            const attachment = socket.deserializeAttachment();
            if (!attachment?.uid) continue;
            this.send(socket, {
                type: "state",
                state: publicState(match, attachment.uid, connectedIds)
            });
        }
    }

    async scheduleAlarm(match) {
        if (match.status === "playing" && Number.isFinite(match.phaseEndsAt)) {
            await this.ctx.storage.setAlarm(match.phaseEndsAt);
        } else {
            await this.ctx.storage.deleteAlarm();
        }
    }

    async saveMatch(match, broadcast = true) {
        await this.ctx.storage.put("match", match);
        await this.scheduleAlarm(match);
        if (broadcast) this.broadcastState(match);
    }

    async acceptConnection(request) {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
            return new Response("WebSocket required", { status: 426 });
        }
        const uid = request.headers.get("X-CACA-UID") || "";
        const role = request.headers.get("X-CACA-ROLE") || "";
        if (!uid || !["player", "spectator"].includes(role)) {
            return new Response("Unauthorized", { status: 401 });
        }
        try {
            await this.setIdentity(request.headers);
            const match = await this.loadMatch(true);
            const identity = await this.getIdentity();
            const sessionDoc = await getFirestoreDocument(this.env, getSessionPath(identity));
            const session = sessionDoc?.data;
            if (!session || Number(session.round) !== identity.round ||
                !["playing", "results"].includes(session.status)) {
                throw new Error("Bulmaca turu artık etkin değil.");
            }
            const matchPlayerIds = uniqueIds(session.matchPlayerIds || session.playerIds);
            const spectatorIds = uniqueIds(session.spectatorIds);
            const validPlayer = role === "player" &&
                matchPlayerIds.includes(uid) &&
                match.activePlayerIds.includes(uid);
            const validSpectator = role === "spectator" && spectatorIds.includes(uid);
            if (!validPlayer && !validSpectator) {
                throw new Error("Bu maç için bağlantı iznin yok.");
            }

            const pair = new WebSocketPair();
            const client = pair[0];
            const server = pair[1];
            this.ctx.acceptWebSocket(server);
            server.serializeAttachment({ uid, role });
            this.sendSnapshot(server, match);
            this.broadcastState(match);
            return new Response(null, { status: 101, webSocket: client });
        } catch (error) {
            return new Response(error?.message || "Bulmaca bağlantısı kurulamadı.", { status: 403 });
        }
    }

    async webSocketMessage(socket, message) {
        return this.enqueue(() => this.processWebSocketMessage(socket, message));
    }

    async processWebSocketMessage(socket, message) {
        let command;
        try {
            const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
            command = JSON.parse(raw);
        } catch {
            this.send(socket, { type: "error", error: "İstek verisi geçersiz." });
            return;
        }
        const attachment = socket.deserializeAttachment();
        const uid = attachment?.uid;
        const requestId = typeof command?.requestId === "string" ? command.requestId : "";
        try {
            if (!uid || attachment.role !== "player") throw new Error("Yanıt vermek için maç oyuncusu olmalısın.");
            if (command.type === "answer") {
                const match = await this.loadMatch(false);
                if (!match) throw new Error("Bulmaca maçı bulunamadı.");
                const result = applyPuzzleAnswer(match, uid, command.optionIndex, Date.now());
                if (allPlayersAnswered(match)) revealPuzzleRound(match, Date.now());
                await this.saveMatch(match);
                this.send(socket, { type: "actionResult", requestId, ok: true, result });
                return;
            }
            if (command.type === "ping") {
                this.send(socket, { type: "actionResult", requestId, ok: true, result: { pong: true } });
                return;
            }
            throw new Error("Bilinmeyen bulmaca hamlesi.");
        } catch (error) {
            this.send(socket, {
                type: "actionResult",
                requestId,
                ok: false,
                error: error?.message || "Yanıt gönderilemedi."
            });
        }
    }

    webSocketClose() {
        const match = this.ctx.storage.get("match");
        Promise.resolve(match).then((value) => {
            if (value) this.broadcastState(value);
        }).catch(() => {});
    }

    webSocketError() {}

    async beginReveal(match, now = Date.now()) {
        if (revealPuzzleRound(match, now)) {
            await this.saveMatch(match);
        }
    }

    async finishMatch(match, now = Date.now()) {
        if (match.status === "results") return;
        match.status = "results";
        match.phase = "results";
        match.phaseStartedAt = now;
        match.phaseEndsAt = null;
        match.finishedAt = now;
        const highest = Math.max(0, ...match.activePlayerIds.map((uid) => Number(match.scores[uid]) || 0));
        match.winnerIds = match.activePlayerIds.filter((uid) => (Number(match.scores[uid]) || 0) === highest);
        await this.ctx.storage.put("match", match);
        await this.syncFinishedResult(match);
        await this.scheduleAlarm(match);
        this.broadcastState(match);
    }

    async syncFinishedResult(match) {
        const identity = await this.getIdentity();
        const path = getSessionPath(identity);
        const sessionDoc = await getFirestoreDocument(this.env, path);
        if (!sessionDoc || Number(sessionDoc.data.round) !== match.round ||
            sessionDoc.data.gameId !== match.gameId) return;
        await patchFirestoreDocument(this.env, path, {
            status: "results",
            playerIds: [...match.playerIds],
            matchPlayerIds: [...match.playerIds],
            winnerIds: [...(match.winnerIds || [])],
            resultReturnIds: [...(match.returnedIds || [])],
            finishedAt: timestampNow(match.finishedAt || Date.now()),
            updatedAt: timestampNow()
        });
    }

    async alarm() {
        return this.enqueue(async () => {
            const match = await this.loadMatch(false);
            if (!match || match.status !== "playing") return;
            const now = Date.now();
            if (match.phaseEndsAt && now < match.phaseEndsAt) {
                await this.scheduleAlarm(match);
                return;
            }
            if (match.phase === "question") {
                revealPuzzleRound(match, now);
                await this.saveMatch(match);
                return;
            }
            if (match.phase === "reveal") {
                advancePuzzleRound(match, now);
                if (match.status === "results") {
                    await this.finishMatch(match, now);
                } else {
                    await this.saveMatch(match);
                }
            }
        });
    }

    async handleHttpAction(request) {
        const uid = request.headers.get("X-CACA-UID") || "";
        const role = request.headers.get("X-CACA-ROLE") || "";
        if (!uid || role !== "player") {
            return Response.json({ error: "Bu işlem için maç oyuncusu olmalısın." }, { status: 403 });
        }
        try {
            await this.setIdentity(request.headers);
            const body = await request.json();
            let result;
            if (body.action === "quit") result = await this.quitPlayer(uid);
            else if (body.action === "returnToLobby") result = await this.returnToLobby(uid);
            else if (body.action === "reconcile") result = await this.reconcileRoster(uid);
            else return Response.json({ error: "Bilinmeyen bulmaca işlemi." }, { status: 400 });
            return Response.json(result);
        } catch (error) {
            return Response.json(
                { error: error?.message || "Bulmaca işlemi tamamlanamadı." },
                { status: 400 }
            );
        }
    }

    async reconcileRoster(uid) {
        const identity = await this.getIdentity();
        const match = await this.loadMatch(false);
        if (!match || match.status !== "playing") return { reconciled: false };
        const sessionDoc = await getFirestoreDocument(this.env, getSessionPath(identity));
        if (!sessionDoc || Number(sessionDoc.data.round) !== match.round) return { reconciled: false };
        const allowed = uniqueIds(sessionDoc.data.matchPlayerIds || sessionDoc.data.playerIds);
        if (!allowed.includes(uid)) return { reconciled: false };
        const next = match.activePlayerIds.filter((id) => allowed.includes(id));
        if (next.length === match.activePlayerIds.length) return { reconciled: false };
        match.activePlayerIds = next;
        match.playerIds = match.playerIds.filter((id) => allowed.includes(id));
        for (const id of Object.keys(match.answers)) if (!allowed.includes(id)) delete match.answers[id];
        if (next.length <= 1) {
            match.playerIds = [...next];
            await this.finishMatch(match);
        } else {
            if (allPlayersAnswered(match)) revealPuzzleRound(match);
            await this.saveMatch(match);
        }
        return { reconciled: true, finished: match.status === "results", winnerIds: match.winnerIds || [] };
    }

    async quitPlayer(uid) {
        const identity = await this.getIdentity();
        const match = await this.loadMatch(false);
        const path = getSessionPath(identity);
        const sessionDoc = await getFirestoreDocument(this.env, path);
        if (!match || !sessionDoc || Number(sessionDoc.data.round) !== match.round ||
            sessionDoc.data.gameId !== match.gameId) {
            throw new Error("Bu bulmaca turu artık etkin değil.");
        }

        const session = sessionDoc.data;
        const oldPlayers = uniqueIds(session.playerIds);
        const oldMatchPlayers = uniqueIds(session.matchPlayerIds || oldPlayers);
        if (!oldPlayers.includes(uid) && !oldMatchPlayers.includes(uid)) {
            throw new Error("Bu oyuncu artık oyun lobisinde değil.");
        }
        const remainingLobbyPlayers = oldPlayers.filter((id) => id !== uid);
        const remainingMatchPlayers = match.playerIds.filter((id) => id !== uid);
        match.playerIds = remainingMatchPlayers;
        match.activePlayerIds = match.activePlayerIds.filter((id) => id !== uid);
        delete match.answers[uid];
        delete match.roundAwards[uid];
        const hostId = session.hostId === uid ? remainingLobbyPlayers[0] || "" : session.hostId;

        if (session.status === "results" || match.status === "results") {
            if (!remainingLobbyPlayers.length) {
                await deleteFirestoreDocument(this.env, path);
                await deleteFirestoreDocument(this.env, "users/" + session.hostId + "/gameState/activeLobby");
                await this.ctx.storage.put("match", match);
                return { left: true, closed: true, finished: true };
            }
            const updates = {
                playerIds: remainingLobbyPlayers,
                matchPlayerIds: remainingMatchPlayers,
                readyIds: uniqueIds(session.readyIds).filter((id) => id !== uid),
                resultReturnIds: uniqueIds(session.resultReturnIds).filter((id) => id !== uid),
                updatedAt: timestampNow()
            };
            if (session.hostId === uid) updates.hostId = hostId;
            await patchFirestoreDocument(this.env, path, updates);
            await this.saveMatch(match);
            return { left: true, finished: true, hostChanged: session.hostId === uid };
        }

        if (!remainingLobbyPlayers.length) {
            await deleteFirestoreDocument(this.env, path);
            await deleteFirestoreDocument(this.env, "users/" + session.hostId + "/gameState/activeLobby");
            match.status = "results";
            match.phase = "results";
            match.phaseEndsAt = null;
            await this.saveMatch(match);
            return { left: true, closed: true, finished: true };
        }

        const sessionPatch = {
            playerIds: remainingLobbyPlayers,
            matchPlayerIds: remainingMatchPlayers,
            readyIds: uniqueIds(session.readyIds).filter((id) => id !== uid),
            spectatorIds: uniqueIds(session.spectatorIds).filter((id) => id !== uid),
            updatedAt: timestampNow()
        };
        if (session.hostId === uid) sessionPatch.hostId = hostId;

        if (match.activePlayerIds.length <= 1) {
            await patchFirestoreDocument(this.env, path, sessionPatch);
            await this.finishMatch(match);
            return {
                left: true,
                finished: true,
                winnerIds: [...match.winnerIds]
            };
        }

        if (allPlayersAnswered(match)) revealPuzzleRound(match);
        await patchFirestoreDocument(this.env, path, sessionPatch);
        await this.saveMatch(match);
        return { left: true, finished: false, hostChanged: session.hostId === uid };
    }

    async returnToLobby(uid) {
        const identity = await this.getIdentity();
        const match = await this.loadMatch(false);
        const path = getSessionPath(identity);
        const sessionDoc = await getFirestoreDocument(this.env, path);
        if (!match || match.status !== "results" || !sessionDoc ||
            Number(sessionDoc.data.round) !== match.round ||
            !match.playerIds.includes(uid)) {
            throw new Error("Bulmaca sonuçları henüz hazır değil veya oyuncu artık aktif değil.");
        }
        const returned = uniqueIds([...(match.returnedIds || []), uid]);
        match.returnedIds = returned;
        const required = [...match.playerIds];
        if (required.every((id) => returned.includes(id))) {
            await patchFirestoreDocument(this.env, path, {
                status: "lobby",
                round: identity.round + 1,
                playerIds: required,
                readyIds: [],
                matchPlayerIds: [],
                spectatorIds: [],
                nextRoundPlayerIds: [],
                nextRoundReadyIds: [],
                resultReturnIds: [],
                winnerIds: [],
                startedAt: null,
                countdownEndsAt: null,
                finishedAt: null,
                updatedAt: timestampNow()
            });
            await this.ctx.storage.put("match", match);
            return { completed: true, round: identity.round + 1, returnedCount: returned.length, requiredCount: required.length };
        }
        await patchFirestoreDocument(this.env, path, {
            resultReturnIds: returned,
            updatedAt: timestampNow()
        });
        await this.saveMatch(match, false);
        return { completed: false, returnedCount: returned.length, requiredCount: required.length };
    }
}
