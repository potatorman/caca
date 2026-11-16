import { DurableObject } from "cloudflare:workers";
import {
    createStarfallBoard,
    scoreStarfallClaim,
    getNextStarfallPlayer,
    getStarfallWinners,
    TURNS_PER_PLAYER,
    MAX_PLAYERS
} from "../../../games/starfall/engine.js";
import {
    deleteFirestoreDocument,
    firestoreTimestamp,
    getFirestoreDocument,
    patchFirestoreDocument
} from "./firebase.js";

const TURN_TIMEOUT_MS = 60_000;

function uniqueIds(values) {
    return [...new Set(Array.isArray(values)
        ? values.filter((value) => typeof value === "string" && value)
        : [])];
}

function getSessionPlayers(session) {
    return uniqueIds(Array.isArray(session?.matchPlayerIds)
        ? session.matchPlayerIds
        : session?.playerIds);
}

function nowTimestamp() {
    return firestoreTimestamp(new Date());
}

function publicState(match, onlineIds) {
    return {
        gameId: "starfall",
        roomId: match.roomId,
        lobbyId: match.lobbyId,
        round: match.round,
        status: match.status,
        playerIds: match.playerIds,
        activePlayerIds: match.activePlayerIds,
        scores: match.scores,
        board: match.board,
        currentPlayerUid: match.currentPlayerUid,
        turnNumber: match.turnNumber,
        maxTurns: match.maxTurns,
        turnsRemainingByPlayer: match.turnsRemainingByPlayer,
        turnStartedAt: match.turnStartedAt,
        turnDeadlineAt: match.turnStartedAt ? match.turnStartedAt + TURN_TIMEOUT_MS : null,
        onlineIds,
        lastMove: match.lastMove,
        winnerId: match.winnerId,
        winnerIds: match.winnerIds,
        finishedAt: match.finishedAt,
        returnedIds: match.returnedIds
    };
}

export class StarfallRoom extends DurableObject {
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
        const roomId = headers.get("X-CACA-ROOM-ID") || "";
        const lobbyId = headers.get("X-CACA-LOBBY-ID") || "";
        const round = Number(headers.get("X-CACA-ROUND"));
        if (
            !/^[A-Za-z0-9_-]{1,128}$/.test(roomId) ||
            (lobbyId !== "active" && !/^[A-Za-z0-9_-]{16,80}$/.test(lobbyId)) ||
            !Number.isInteger(round) ||
            round < 1
        ) {
            throw new Error("Starfall oda veya tur bilgisi geçersiz.");
        }
        const current = await this.ctx.storage.get("identity");
        if (current && (
            current.roomId !== roomId ||
            current.lobbyId !== lobbyId ||
            current.round !== round
        )) {
            throw new Error("Starfall oda kimliği bu Durable Object ile eşleşmiyor.");
        }
        const identity = { roomId, lobbyId, round };
        await this.ctx.storage.put("identity", identity);
        return identity;
    }

    async getIdentity() {
        const identity = await this.ctx.storage.get("identity");
        if (!identity) throw new Error("Starfall oda kimliği henüz başlatılmadı.");
        return identity;
    }

    sessionPath(identity) {
        return "rooms/" + identity.roomId + "/gameSessions/" + identity.lobbyId;
    }

    async readSession(identity = null) {
        const current = identity || await this.getIdentity();
        return getFirestoreDocument(this.env, this.sessionPath(current));
    }

    async loadMatch(createIfMissing = true) {
        const existing = await this.ctx.storage.get("match");
        if (existing || !createIfMissing) return existing || null;

        const identity = await this.getIdentity();
        const sessionDoc = await this.readSession(identity);
        if (!sessionDoc) throw new Error("Starfall oyun lobisi bulunamadı.");
        const session = sessionDoc.data;
        if (
            session.gameId !== "starfall" ||
            session.status !== "playing" ||
            Number(session.round) !== identity.round
        ) {
            throw new Error("Starfall maçı başlatılmaya hazır değil.");
        }

        const players = getSessionPlayers(session);
        if (players.length < 2 || players.length > MAX_PLAYERS) {
            throw new Error("Starfall için 2–8 aktif oyuncu gerekli.");
        }

        const startedAt = Date.now();
        const match = {
            ...identity,
            status: "playing",
            playerIds: [...players],
            activePlayerIds: [...players],
            board: createStarfallBoard(),
            scores: Object.fromEntries(players.map((uid) => [uid, 0])),
            turnsRemainingByPlayer: Object.fromEntries(
                players.map((uid) => [uid, TURNS_PER_PLAYER])
            ),
            currentPlayerIndex: 0,
            currentPlayerUid: players[0],
            turnNumber: 1,
            maxTurns: players.length * TURNS_PER_PLAYER,
            turnStartedAt: startedAt,
            lastMove: null,
            winnerId: null,
            winnerIds: [],
            finishedAt: null,
            returnedIds: [],
            createdAt: startedAt
        };
        await this.ctx.storage.put("match", match);
        await this.scheduleTurnAlarm(match);
        return match;
    }

    onlinePlayerIds() {
        return uniqueIds(this.ctx.getWebSockets().map((socket) => {
            try {
                return socket.deserializeAttachment()?.uid || "";
            } catch {
                return "";
            }
        }));
    }

    async scheduleTurnAlarm(match) {
        if (match.status === "playing" && match.currentPlayerUid) {
            await this.ctx.storage.setAlarm(match.turnStartedAt + TURN_TIMEOUT_MS);
        } else {
            await this.ctx.storage.deleteAlarm();
        }
    }

    async saveMatch(match, broadcast = true) {
        await this.ctx.storage.put("match", match);
        await this.scheduleTurnAlarm(match);
        if (broadcast) this.broadcastState(match);
    }

    send(socket, payload) {
        try {
            socket.send(JSON.stringify(payload));
        } catch {
            // A disconnected socket is dropped by the runtime.
        }
    }

    sendSnapshot(socket, match) {
        this.send(socket, {
            type: "state",
            state: publicState(match, this.onlinePlayerIds())
        });
    }

    broadcastState(match) {
        const state = publicState(match, this.onlinePlayerIds());
        for (const socket of this.ctx.getWebSockets()) {
            this.send(socket, { type: "state", state });
        }
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
            const identity = await this.setIdentity(request.headers);
            const match = await this.loadMatch(true);
            const sessionDoc = await this.readSession(identity);
            const session = sessionDoc?.data;
            if (!session || Number(session.round) !== match.round || session.gameId !== "starfall") {
                throw new Error("Starfall turu artık etkin değil.");
            }
            const currentPlayers = getSessionPlayers(session);
            const spectators = uniqueIds(session.spectatorIds);
            const validPlayer = role === "player" &&
                currentPlayers.includes(uid) &&
                match.activePlayerIds.includes(uid);
            const validSpectator = role === "spectator" && spectators.includes(uid);
            if (!validPlayer && !validSpectator) {
                throw new Error("Bu maç için bağlantı iznin yok.");
            }
            if (match.status === "results") await this.syncFinishedResult(match);
        } catch (error) {
            return new Response(error.message || "Starfall bağlantısı kurulamadı.", { status: 403 });
        }

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ uid, role });
        const match = await this.loadMatch(false);
        this.sendSnapshot(server, match);
        this.broadcastState(match);
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(socket, message) {
        return this.enqueue(() => this.processWebSocketMessage(socket, message));
    }

    async processWebSocketMessage(socket, message) {
        let command;
        try {
            const raw = typeof message === "string"
                ? message
                : new TextDecoder().decode(message);
            command = JSON.parse(raw);
        } catch {
            this.send(socket, { type: "error", error: "İstek verisi geçersiz." });
            return;
        }

        const attachment = socket.deserializeAttachment();
        const uid = attachment?.uid;
        const role = attachment?.role;
        const requestId = command?.requestId || null;
        if (!uid || role !== "player") {
            this.send(socket, {
                type: "actionResult",
                requestId,
                ok: false,
                error: "İzleyiciler oyun hamlesi yapamaz."
            });
            return;
        }

        try {
            const match = await this.loadMatch(false);
            if (!match) throw new Error("Starfall maçı bulunamadı.");
            const identity = await this.getIdentity();
            const sessionDoc = await this.readSession(identity);
            const session = sessionDoc?.data;
            if (
                !session ||
                session.gameId !== "starfall" ||
                session.status !== "playing" ||
                Number(session.round) !== match.round ||
                !getSessionPlayers(session).includes(uid) ||
                !match.activePlayerIds.includes(uid)
            ) {
                throw new Error("Bu Starfall maçında artık aktif oyuncu değilsin.");
            }

            if (command.type === "ping") {
                this.send(socket, { type: "actionResult", requestId, ok: true, result: { pong: true } });
                return;
            }
            if (match.status !== "playing") throw new Error("Starfall maçı tamamlandı.");
            if (match.currentPlayerUid !== uid) throw new Error("Şu anda sıra sende değil.");
            if (command.type !== "claim") throw new Error("Bilinmeyen Starfall hamlesi.");

            const cellIndex = Number(command.cellIndex);
            const score = scoreStarfallClaim(match.board, cellIndex, uid);
            const cell = match.board[cellIndex];
            cell.ownerId = uid;
            cell.awardedPoints = score.totalPoints;
            match.scores[uid] = (Number(match.scores[uid]) || 0) + score.totalPoints;
            match.lastMove = {
                uid,
                cellIndex,
                basePoints: score.basePoints,
                connectionBonus: score.connectionBonus,
                starBonus: score.starBonus,
                totalPoints: score.totalPoints,
                turnNumber: match.turnNumber,
                at: Date.now()
            };

            match.turnsRemainingByPlayer[uid] = Math.max(
                0,
                (Number(match.turnsRemainingByPlayer[uid]) || 0) - 1
            );
            match.turnNumber += 1;
            this.advanceTurn(match);
            await this.saveMatch(match);
            if (match.status === "results") await this.syncFinishedResult(match);
            this.send(socket, {
                type: "actionResult",
                requestId,
                ok: true,
                result: score
            });
        } catch (error) {
            this.send(socket, {
                type: "actionResult",
                requestId,
                ok: false,
                error: error?.message || "Starfall hamlesi tamamlanamadı."
            });
        }
    }

    advanceTurn(match) {
        const next = getNextStarfallPlayer(
            match.playerIds,
            match.turnsRemainingByPlayer,
            match.currentPlayerIndex
        );
        if (!next) {
            this.finishMatch(match);
            return;
        }
        match.currentPlayerIndex = next.index;
        match.currentPlayerUid = next.uid;
        match.turnStartedAt = Date.now();
    }

    finishMatch(match, forcedWinnerIds = null) {
        const winnerIds = forcedWinnerIds || getStarfallWinners(
            match.scores,
            match.activePlayerIds
        );
        match.status = "results";
        match.winnerIds = [...winnerIds];
        match.winnerId = winnerIds.length === 1 ? winnerIds[0] : null;
        match.currentPlayerUid = null;
        match.turnStartedAt = null;
        match.finishedAt = Date.now();
    }

    async syncFinishedResult(match) {
        if (match.status !== "results") return;
        const identity = await this.getIdentity();
        const sessionDoc = await this.readSession(identity);
        if (!sessionDoc || Number(sessionDoc.data.round) !== match.round) return;
        const eligiblePlayers = new Set(getSessionPlayers(sessionDoc.data));
        const resultPlayers = match.activePlayerIds.filter((uid) => eligiblePlayers.has(uid));
        await patchFirestoreDocument(this.env, this.sessionPath(identity), {
            status: "results",
            readyIds: [],
            matchPlayerIds: resultPlayers,
            resultReturnIds: [...match.returnedIds],
            finishedAt: firestoreTimestamp(new Date(match.finishedAt || Date.now())),
            updatedAt: nowTimestamp()
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
            if (body.action === "quit") {
                result = await this.quitPlayer(uid);
            } else if (body.action === "returnToLobby") {
                result = await this.returnToLobby(uid);
            } else if (body.action === "reconcile") {
                result = await this.reconcileRoster(uid);
            } else {
                return Response.json({ error: "Desteklenmeyen Starfall işlemi." }, { status: 400 });
            }
            return Response.json(result);
        } catch (error) {
            return Response.json(
                { error: error?.message || "Starfall işlemi tamamlanamadı." },
                { status: 400 }
            );
        }
    }

    async quitPlayer(uid) {
        const identity = await this.getIdentity();
        const sessionDoc = await this.readSession(identity);
        const session = sessionDoc?.data;
        if (
            !session ||
            session.gameId !== "starfall" ||
            session.status !== "playing" ||
            Number(session.round) !== identity.round
        ) {
            throw new Error("Bu Starfall turu artık aktif değil.");
        }

        const match = await this.loadMatch(false);
        if (!match || !match.activePlayerIds.includes(uid)) {
            return { left: false, reason: "not-active" };
        }

        const nextLobbyPlayers = uniqueIds(session.playerIds).filter((id) => id !== uid);
        const nextActivePlayers = match.activePlayerIds.filter((id) => id !== uid);
        const nextHost = session.hostId === uid
            ? (nextLobbyPlayers[0] || nextActivePlayers[0] || "")
            : session.hostId;

        match.activePlayerIds = nextActivePlayers;
        match.turnsRemainingByPlayer[uid] = 0;

        if (!nextActivePlayers.length) {
            const nextPlayers = uniqueIds([
                ...nextLobbyPlayers,
                ...uniqueIds(session.spectatorIds),
                ...uniqueIds(session.nextRoundPlayerIds)
            ]);
            if (!nextPlayers.length) {
                await deleteFirestoreDocument(this.env, this.sessionPath(identity));
            } else {
                await patchFirestoreDocument(this.env, this.sessionPath(identity), {
                    status: "lobby",
                    round: identity.round + 1,
                    hostId: nextPlayers.includes(nextHost) ? nextHost : nextPlayers[0],
                    playerIds: nextPlayers,
                    readyIds: [],
                    matchPlayerIds: [],
                    spectatorIds: [],
                    nextRoundPlayerIds: [],
                    nextRoundReadyIds: [],
                    resultReturnIds: [],
                    startedAt: null,
                    countdownEndsAt: null,
                    finishedAt: null,
                    updatedAt: nowTimestamp()
                });
            }
            match.status = "cancelled";
            match.currentPlayerUid = null;
            match.turnStartedAt = null;
            await this.saveMatch(match, false);
            return { left: true, finished: false, cancelledRound: true };
        }

        if (nextActivePlayers.length === 1) {
            this.finishMatch(match, [nextActivePlayers[0]]);
        } else if (match.currentPlayerUid === uid) {
            const next = getNextStarfallPlayer(
                match.playerIds,
                match.turnsRemainingByPlayer,
                match.currentPlayerIndex
            );
            if (!next) this.finishMatch(match);
            else {
                match.currentPlayerIndex = next.index;
                match.currentPlayerUid = next.uid;
                match.turnStartedAt = Date.now();
            }
        }

        await patchFirestoreDocument(this.env, this.sessionPath(identity), {
            status: match.status,
            hostId: nextHost || nextActivePlayers[0],
            playerIds: nextLobbyPlayers,
            readyIds: [],
            matchPlayerIds: nextActivePlayers,
            resultReturnIds: [],
            ...(match.status === "results" ? {
                finishedAt: firestoreTimestamp(new Date(match.finishedAt))
            } : {}),
            updatedAt: nowTimestamp()
        });
        await this.saveMatch(match);
        if (match.status === "results") await this.syncFinishedResult(match);
        return {
            left: true,
            finished: match.status === "results",
            winner: match.winnerId,
            winners: match.winnerIds
        };
    }

    async reconcileRoster(uid) {
        const identity = await this.getIdentity();
        const match = await this.loadMatch(false);
        if (!match || match.status !== "playing") return { reconciled: false };
        const sessionDoc = await this.readSession(identity);
        const session = sessionDoc?.data;
        if (!session || session.status !== "playing" || Number(session.round) !== identity.round) {
            return { reconciled: false };
        }
        const allowed = getSessionPlayers(session);
        if (!allowed.includes(uid)) return { reconciled: false };
        const nextRoster = match.activePlayerIds.filter((id) => allowed.includes(id));
        if (
            nextRoster.length === match.activePlayerIds.length &&
            nextRoster.every((id, index) => id === match.activePlayerIds[index])
        ) return { reconciled: false };
        if (!nextRoster.length) throw new Error("Starfall maçında aktif oyuncu kalmadı.");

        match.activePlayerIds = nextRoster;
        for (const id of match.playerIds) {
            if (!nextRoster.includes(id)) match.turnsRemainingByPlayer[id] = 0;
        }
        if (nextRoster.length === 1) {
            this.finishMatch(match, [nextRoster[0]]);
        } else if (!nextRoster.includes(match.currentPlayerUid)) {
            const oldIndex = match.playerIds.indexOf(match.currentPlayerUid);
            const next = getNextStarfallPlayer(match.playerIds, match.turnsRemainingByPlayer, oldIndex);
            if (!next) this.finishMatch(match);
            else {
                match.currentPlayerUid = next.uid;
                match.currentPlayerIndex = next.index;
                match.turnStartedAt = Date.now();
            }
        }

        await patchFirestoreDocument(this.env, this.sessionPath(identity), {
            status: match.status,
            matchPlayerIds: nextRoster,
            ...(match.status === "results" ? {
                finishedAt: firestoreTimestamp(new Date(match.finishedAt))
            } : {}),
            updatedAt: nowTimestamp()
        });
        await this.saveMatch(match);
        if (match.status === "results") await this.syncFinishedResult(match);
        return { reconciled: true, finished: match.status === "results", winner: match.winnerId };
    }

    async returnToLobby(uid) {
        const identity = await this.getIdentity();
        const match = await this.loadMatch(false);
        if (!match || match.status !== "results") {
            throw new Error("Starfall sonuçları henüz hazır değil.");
        }
        if (!match.activePlayerIds.includes(uid)) {
            throw new Error("Bu oyuncu Starfall sonuç ekranında aktif değil.");
        }
        await this.syncFinishedResult(match);

        const sessionDoc = await this.readSession(identity);
        const session = sessionDoc?.data;
        if (!session || session.status !== "results" || Number(session.round) !== identity.round) {
            throw new Error("Firebase oyun lobisi sonuç aşamasında değil.");
        }
        const players = getSessionPlayers(session);
        if (!players.includes(uid)) throw new Error("Bu oyuncu sonuç ekranında aktif değil.");

        const returned = uniqueIds(match.returnedIds);
        if (!returned.includes(uid)) returned.push(uid);
        match.returnedIds = returned;
        const allReturned = players.length > 0 && players.every((id) => returned.includes(id));
        if (!allReturned) {
            await patchFirestoreDocument(this.env, this.sessionPath(identity), {
                resultReturnIds: returned,
                updatedAt: nowTimestamp()
            });
            await this.ctx.storage.put("match", match);
            return {
                completed: false,
                returnedCount: returned.length,
                requiredCount: players.length,
                waitingFor: players.filter((id) => !returned.includes(id))
            };
        }

        const nextPlayers = uniqueIds([
            ...uniqueIds(session.playerIds),
            ...uniqueIds(session.spectatorIds),
            ...uniqueIds(session.nextRoundPlayerIds)
        ]);
        if (nextPlayers.length > MAX_PLAYERS) {
            throw new Error("Sonraki Starfall lobisi 8 oyuncu sınırını aşıyor.");
        }
        const nextHost = nextPlayers.includes(session.hostId) ? session.hostId : nextPlayers[0];
        await patchFirestoreDocument(this.env, this.sessionPath(identity), {
            status: "lobby",
            round: identity.round + 1,
            hostId: nextHost,
            playerIds: nextPlayers,
            readyIds: [],
            matchPlayerIds: [],
            spectatorIds: [],
            nextRoundPlayerIds: [],
            nextRoundReadyIds: [],
            resultReturnIds: [],
            startedAt: null,
            countdownEndsAt: null,
            finishedAt: null,
            updatedAt: nowTimestamp()
        });
        await this.ctx.storage.put("match", match);
        await this.ctx.storage.deleteAlarm();
        return {
            completed: true,
            round: identity.round + 1,
            returnedCount: players.length,
            requiredCount: players.length
        };
    }

    webSocketClose() {
        const match = this.ctx.storage.get("match");
        void match.then((value) => {
            if (value) this.broadcastState(value);
        }).catch(() => {});
    }

    webSocketError(socket) {
        try { socket.close(1011, "Socket error"); } catch {}
    }

    async alarm() {
        return this.enqueue(async () => {
            const match = await this.loadMatch(false);
            if (!match || match.status !== "playing" || !match.currentPlayerUid) return;
            if (Date.now() < match.turnStartedAt + TURN_TIMEOUT_MS) {
                await this.scheduleTurnAlarm(match);
                return;
            }
            const uid = match.currentPlayerUid;
            match.turnsRemainingByPlayer[uid] = Math.max(
                0,
                (Number(match.turnsRemainingByPlayer[uid]) || 0) - 1
            );
            match.lastMove = {
                uid,
                skipped: true,
                reason: "timeout",
                turnNumber: match.turnNumber,
                at: Date.now()
            };
            match.turnNumber += 1;
            this.advanceTurn(match);
            await this.saveMatch(match);
            if (match.status === "results") await this.syncFinishedResult(match);
        });
    }
}
