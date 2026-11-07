import { DurableObject } from "cloudflare:workers";
import { createUnoDeck, shuffleDeck } from "../../../games/uno/deck.js";
import {
    UNO_COLORS,
    getPlayEffect,
    isCardPlayable,
    nextPlayerIndex
} from "../../../games/uno/engine.js";
import {
    deleteFirestoreDocument,
    firestoreTimestamp,
    getFirestoreDocument,
    patchFirestoreDocument
} from "./firebase.js";

const HAND_SIZE = 7;
const TURN_TIMEOUT_MS = 90_000;
const MAX_PLAYERS = 10;

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

function nextRemaining(previous, remaining, currentUid, direction, fallbackIndex = 0) {
    if (!remaining.length) return null;
    if (remaining.includes(currentUid)) return currentUid;
    const list = uniqueIds(previous);
    if (!list.length) return remaining[0];
    const index = Math.max(0, Math.min(Number(fallbackIndex) || 0, list.length - 1));

    for (let step = 1; step <= list.length; step += 1) {
        const offset = direction === -1 ? -step : step;
        const candidate = list[(index + offset + list.length * 2) % list.length];
        if (remaining.includes(candidate)) return candidate;
    }
    return remaining[0];
}

function publicState(match, uid) {
    return {
        roomId: match.roomId,
        round: match.round,
        status: match.status,
        playerIds: match.playerIds,
        activePlayerIds: match.activePlayerIds,
        dealerId: match.dealerId,
        direction: match.direction,
        currentPlayerIndex: match.currentPlayerIndex,
        currentPlayerUid: match.currentPlayerUid,
        activeColor: match.activeColor,
        topCard: match.topCard,
        drawCount: match.drawPile.length,
        handCounts: match.handCounts,
        drewCardId: match.currentPlayerUid === uid ? match.drewCardId : null,
        unoPendingUid: match.unoPendingUid,
        unoCalled: match.unoCalled,
        winnerId: match.winnerId,
        turnNumber: match.turnNumber,
        turnStartedAt: match.turnStartedAt,
        finishedAt: match.finishedAt
    };
}

function timestampNow() {
    return firestoreTimestamp(new Date());
}

function takeCards(match, count) {
    let drawPile = [...match.drawPile];
    let discardPile = [...match.discardPile];

    if (drawPile.length < count) {
        const topCard = discardPile[discardPile.length - 1] || match.topCard;
        const recyclable = discardPile.slice(0, -1);
        drawPile = drawPile.concat(shuffleDeck(recyclable));
        discardPile = topCard ? [topCard] : [];
    }

    const cards = drawPile.splice(0, count);
    match.drawPile = drawPile;
    match.discardPile = discardPile;
    return cards;
}

export class UnoRoom extends DurableObject {
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

    async loadMatch(createIfMissing = true) {
        const existing = await this.ctx.storage.get("match");
        if (existing || !createIfMissing) return existing || null;

        const { roomId, round } = await this.getIdentity();
        const sessionDoc = await getFirestoreDocument(
            this.env,
            "rooms/" + roomId + "/gameSessions/active"
        );
        if (!sessionDoc) throw new Error("Firebase oyun lobisi bulunamadı.");

        const session = sessionDoc.data;
        if (
            session.gameId !== "uno" ||
            session.status !== "playing" ||
            Number(session.round) !== round
        ) {
            throw new Error("UNO maçı başlatılmaya hazır değil.");
        }

        const players = getSessionPlayers(session);
        if (players.length < 2 || players.length > MAX_PLAYERS) {
            throw new Error("UNO için 2–10 aktif oyuncu gerekli.");
        }

        const deck = shuffleDeck(createUnoDeck());
        const hands = {};
        for (const uid of players) {
            hands[uid] = deck.splice(0, HAND_SIZE);
        }

        const openingCardIndex = deck.findIndex((card) => card.type === "number");
        if (openingCardIndex < 0 || players.some((uid) => hands[uid].length !== HAND_SIZE)) {
            throw new Error("UNO destesi hazırlanamadı.");
        }
        const [topCard] = deck.splice(openingCardIndex, 1);
        const currentTime = Date.now();

        const match = {
            roomId,
            round,
            status: "playing",
            playerIds: [...players],
            activePlayerIds: [...players],
            dealerId: players.includes(session.hostId) ? session.hostId : players[0],
            direction: 1,
            currentPlayerIndex: 0,
            currentPlayerUid: players[0],
            activeColor: topCard.color,
            topCard,
            discardPile: [topCard],
            drawPile: deck,
            hands,
            handCounts: Object.fromEntries(players.map((uid) => [uid, HAND_SIZE])),
            drewCardId: null,
            unoPendingUid: null,
            unoCalled: false,
            winnerId: null,
            forfeitedBy: null,
            turnNumber: 1,
            turnStartedAt: currentTime,
            finishedAt: null,
            returnedIds: [],
            firebaseResultSynced: false,
            createdAt: currentTime
        };

        await this.ctx.storage.put("match", match);
        await this.scheduleTurnAlarm(match);
        return match;
    }

    async setIdentity(headers) {
        const roomId = headers.get("X-CACA-ROOM-ID") || "";
        const round = Number(headers.get("X-CACA-ROUND"));
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(roomId) ||
            !Number.isInteger(round) || round < 1) {
            throw new Error("UNO oda veya tur bilgisi geçersiz.");
        }
        const current = await this.ctx.storage.get("identity");
        if (current && (current.roomId !== roomId || current.round !== round)) {
            throw new Error("UNO oda kimliği bu Durable Object ile eşleşmiyor.");
        }
        await this.ctx.storage.put("identity", { roomId, round });
        return { roomId, round };
    }

    async getIdentity() {
        const identity = await this.ctx.storage.get("identity");
        if (!identity) throw new Error("UNO oda kimliği henüz başlatılmadı.");
        return identity;
    }

    async scheduleTurnAlarm(match) {
        if (match.status === "playing") {
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
            // A disconnected socket is removed by its close event.
        }
    }

    sendSnapshot(socket, match) {
        const attachment = socket.deserializeAttachment();
        const uid = attachment?.uid;
        const role = attachment?.role;
        this.send(socket, {
            type: "state",
            state: publicState(match, uid)
        });
        if (role === "player") {
            this.send(socket, {
                type: "hand",
                hand: { cards: match.hands[uid] || [] }
            });
        }
    }

    broadcastState(match) {
        for (const socket of this.ctx.getWebSockets()) {
            const attachment = socket.deserializeAttachment();
            if (!attachment?.uid) continue;
            this.sendSnapshot(socket, match);
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
            await this.setIdentity(request.headers);
        } catch (error) {
            return new Response(error.message || "UNO kimliği geçersiz.", { status: 400 });
        }

        let match;
        try {
            match = await this.loadMatch(true);
            const sessionDoc = await getFirestoreDocument(
                this.env,
                "rooms/" + match.roomId + "/gameSessions/active"
            );
            const session = sessionDoc?.data;
            if (!session || Number(session.round) !== match.round) {
                throw new Error("UNO turu artık etkin değil.");
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
            return new Response(error.message || "UNO bağlantısı kurulamadı.", { status: 403 });
        }

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ uid, role });
        this.sendSnapshot(server, match);
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
        const requestId = command.requestId || null;
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
            if (!match) throw new Error("UNO maçı bulunamadı.");
            let result;

            switch (command.type) {
                case "playCard":
                    result = await this.playCard(match, uid, command.cardId, command.selectedColor ?? null);
                    break;
                case "drawCard":
                    result = this.drawCard(match, uid);
                    break;
                case "endTurn":
                    result = this.endTurn(match, uid);
                    break;
                case "callUno":
                    result = this.callUno(match, uid);
                    break;
                case "catchUno":
                    result = this.catchUno(match, uid);
                    break;
                case "ping":
                    result = { pong: true };
                    break;
                default:
                    throw new Error("Bilinmeyen UNO hamlesi.");
            }

            await this.saveMatch(match);
            if (match.status === "results") await this.syncFinishedResult(match);
            this.send(socket, { type: "actionResult", requestId, ok: true, result });
        } catch (error) {
            this.send(socket, {
                type: "actionResult",
                requestId,
                ok: false,
                error: error?.message || "UNO hamlesi tamamlanamadı."
            });
        }
    }

    webSocketClose() {}
    webSocketError() {}

    requireTurn(match, uid) {
        if (match.status !== "playing") throw new Error("Bu UNO maçı artık devam etmiyor.");
        if (!match.activePlayerIds.includes(uid)) {
            throw new Error("Bu maçın aktif oyuncusu değilsin.");
        }
        if (match.currentPlayerUid !== uid) throw new Error("Sıra sende değil.");
    }

    requireActive(match, uid) {
        if (match.status !== "playing" || !match.activePlayerIds.includes(uid)) {
            throw new Error("Bu maçın aktif oyuncusu değilsin.");
        }
    }

    advanceTurn(match, index, direction) {
        const safeIndex = nextPlayerIndex(
            index,
            direction,
            match.activePlayerIds.length,
            0
        );
        match.currentPlayerIndex = safeIndex;
        match.currentPlayerUid = match.activePlayerIds[safeIndex];
        match.direction = direction;
        match.drewCardId = null;
        match.unoPendingUid = null;
        match.unoCalled = false;
        match.turnNumber += 1;
        match.turnStartedAt = Date.now();
    }

    async playCard(match, uid, cardId, selectedColor) {
        this.requireTurn(match, uid);
        const hand = match.hands[uid] || [];
        const card = hand.find((item) => item.id === cardId);
        if (!card) throw new Error("Bu kart elinde bulunmuyor.");
        if (match.drewCardId && match.drewCardId !== card.id) {
            throw new Error("Kart çektikten sonra yalnızca çektiğin kartı oynayabilirsin.");
        }
        if (!isCardPlayable(card, match.topCard, match.activeColor, hand)) {
            throw new Error(card.type === "wild4"
                ? "+4 kartı, elinde aktif renkten kart yoksa oynanabilir."
                : "Bu kart mevcut renkle veya kart sembolüyle eşleşmiyor.");
        }

        const wild = card.type === "wild" || card.type === "wild4";
        if (wild && !UNO_COLORS.includes(selectedColor)) {
            throw new Error("Renk değiştirme kartı için bir renk seçmelisin.");
        }
        if (!wild && selectedColor !== null) {
            throw new Error("Normal kartlarda renk seçilemez.");
        }

        const remainingHand = hand.filter((item) => item.id !== card.id);
        match.hands[uid] = remainingHand;
        match.discardPile.push(card);
        match.topCard = card;
        match.activeColor = wild ? selectedColor : card.color;
        match.handCounts[uid] = remainingHand.length;
        match.drewCardId = null;

        if (remainingHand.length === 0) {
            match.status = "results";
            match.winnerId = uid;
            match.unoPendingUid = null;
            match.unoCalled = false;
            match.finishedAt = Date.now();
            return { winner: true, card };
        }

        const effect = getPlayEffect(card, match.activePlayerIds.length, match.direction);
        let direction = effect.direction;
        let next = nextPlayerIndex(
            match.currentPlayerIndex,
            direction,
            match.activePlayerIds.length,
            effect.steps
        );

        if (effect.drawCount) {
            const targetIndex = nextPlayerIndex(
                match.currentPlayerIndex,
                match.direction,
                match.activePlayerIds.length,
                effect.targetIndexOffset
            );
            const targetUid = match.activePlayerIds[targetIndex];
            const targetCards = match.hands[targetUid] || [];
            const drawnCards = takeCards(match, effect.drawCount);
            match.hands[targetUid] = [...targetCards, ...drawnCards];
            match.handCounts[targetUid] = match.hands[targetUid].length;
            next = nextPlayerIndex(
                targetIndex,
                match.direction,
                match.activePlayerIds.length,
                1
            );
            direction = match.direction;
        }

        match.currentPlayerIndex = next;
        match.currentPlayerUid = match.activePlayerIds[next];
        match.direction = direction;
        match.unoPendingUid = remainingHand.length === 1 ? uid : null;
        match.unoCalled = false;
        match.turnNumber += 1;
        match.turnStartedAt = Date.now();
        return { winner: false, card };
    }

    drawCard(match, uid) {
        this.requireTurn(match, uid);
        if (match.drewCardId) throw new Error("Bu turda zaten kart çektin.");

        const hand = match.hands[uid] || [];
        const [card] = takeCards(match, 1);
        if (!card) {
            const next = nextPlayerIndex(
                match.currentPlayerIndex,
                match.direction,
                match.activePlayerIds.length,
                1
            );
            this.advanceTurn(match, next, match.direction);
            return { card: null, playable: false, empty: true };
        }

        const nextHand = [...hand, card];
        match.hands[uid] = nextHand;
        match.handCounts[uid] = nextHand.length;
        const playable = isCardPlayable(card, match.topCard, match.activeColor, hand);
        if (playable) {
            match.drewCardId = card.id;
        } else {
            const next = nextPlayerIndex(
                match.currentPlayerIndex,
                match.direction,
                match.activePlayerIds.length,
                1
            );
            this.advanceTurn(match, next, match.direction);
        }
        return { card, playable, empty: false };
    }

    endTurn(match, uid) {
        this.requireTurn(match, uid);
        if (!match.drewCardId) throw new Error("Önce kart çekmelisin.");
        const next = nextPlayerIndex(
            match.currentPlayerIndex,
            match.direction,
            match.activePlayerIds.length,
            1
        );
        this.advanceTurn(match, next, match.direction);
        return { ended: true };
    }

    callUno(match, uid) {
        this.requireActive(match, uid);
        if (match.unoPendingUid !== uid || match.unoCalled) {
            throw new Error("Şu anda UNO çağrısı yapamazsın.");
        }
        match.unoCalled = true;
        return { called: true };
    }

    catchUno(match, uid) {
        this.requireActive(match, uid);
        if (!match.unoPendingUid || match.unoCalled || match.unoPendingUid === uid) {
            throw new Error("Yakalanabilecek bir UNO çağrısı yok.");
        }
        const targetUid = match.unoPendingUid;
        const targetHand = match.hands[targetUid] || [];
        const penalty = takeCards(match, 2);
        match.hands[targetUid] = [...targetHand, ...penalty];
        match.handCounts[targetUid] = match.hands[targetUid].length;
        match.unoPendingUid = null;
        match.unoCalled = false;
        return { targetUid, count: penalty.length };
    }

    async syncFinishedResult(match) {
        if (match.status !== "results" || match.firebaseResultSynced) return;
        const sessionPath = "rooms/" + match.roomId + "/gameSessions/active";
        const sessionDoc = await getFirestoreDocument(this.env, sessionPath);
        if (!sessionDoc || Number(sessionDoc.data.round) !== match.round) {
            throw new Error("UNO sonucu Firebase oyun lobisine yazılamadı: tur değişmiş.");
        }

        const session = sessionDoc.data;
        if (session.status === "playing") {
            await patchFirestoreDocument(this.env, sessionPath, {
                status: "results",
                readyIds: [],
                resultReturnIds: [],
                finishedAt: firestoreTimestamp(new Date(match.finishedAt)),
                updatedAt: timestampNow()
            });
        } else if (session.status !== "results") {
            throw new Error("UNO sonucu için Firebase oturum durumu geçersiz.");
        }

        await patchFirestoreDocument(
            this.env,
            "rooms/" + match.roomId + "/unoResults/" + String(match.round),
            {
                gameId: "uno",
                round: match.round,
                status: "results",
                playerIds: match.playerIds,
                activePlayerIds: match.activePlayerIds,
                winnerId: match.winnerId,
                handCounts: match.handCounts,
                finishedAt: firestoreTimestamp(new Date(match.finishedAt)),
                resultReturnIds: match.returnedIds || []
            }
        );
        match.firebaseResultSynced = true;
        await this.ctx.storage.put("match", match);
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
                return Response.json({ error: "Bilinmeyen UNO işlemi." }, { status: 400 });
            }
            return Response.json(result);
        } catch (error) {
            return Response.json(
                { error: error?.message || "UNO işlemi tamamlanamadı." },
                { status: 400 }
            );
        }
    }

    async cancelBeforeDeal(uid, session) {
        const { roomId } = await this.getIdentity();
        const path = "rooms/" + roomId + "/gameSessions/active";
        const players = uniqueIds(session.playerIds);
        const matchPlayers = getSessionPlayers(session);
        if (!players.includes(uid) || !matchPlayers.includes(uid)) {
            return { left: false, reason: "not-active" };
        }

        const remainingPlayers = players.filter((id) => id !== uid);
        const spectators = uniqueIds(session.spectatorIds);
        const nextPlayers = uniqueIds([
            ...remainingPlayers,
            ...spectators,
            ...uniqueIds(session.nextRoundPlayerIds)
        ]);
        if (!nextPlayers.length) {
            await deleteFirestoreDocument(this.env, path);
            return { left: true, finished: false, cancelledBeforeDeal: true };
        }

        const hostId = session.hostId === uid
            ? nextPlayers[0]
            : (nextPlayers.includes(session.hostId) ? session.hostId : nextPlayers[0]);
        await patchFirestoreDocument(this.env, path, {
            status: "lobby",
            round: Number(session.round) + 1,
            hostId,
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
            updatedAt: timestampNow()
        });
        return { left: true, finished: false, cancelledBeforeDeal: true };
    }

    async quitPlayer(uid) {
        const { roomId, round } = await this.getIdentity();
        const sessionPath = "rooms/" + roomId + "/gameSessions/active";
        const sessionDoc = await getFirestoreDocument(this.env, sessionPath);
        if (!sessionDoc || Number(sessionDoc.data.round) !== round ||
            sessionDoc.data.gameId !== "uno" || sessionDoc.data.status !== "playing") {
            throw new Error("Bu UNO turu artık aktif değil.");
        }

        const session = sessionDoc.data;
        const match = await this.loadMatch(false);
        if (!match) return this.cancelBeforeDeal(uid, session);
        if (!match.activePlayerIds.includes(uid) || !session.playerIds?.includes(uid)) {
            return { left: false, reason: "not-active" };
        }

        const nextLobby = uniqueIds(session.playerIds).filter((id) => id !== uid);
        const nextRoster = match.activePlayerIds.filter((id) => id !== uid);
        const nextHost = session.hostId === uid
            ? (nextLobby[0] || nextRoster[0] || "")
            : session.hostId;
        const changedAt = Date.now();

        if (nextRoster.length === 0) {
            const nextPlayers = uniqueIds([
                ...nextLobby,
                ...uniqueIds(session.spectatorIds),
                ...uniqueIds(session.nextRoundPlayerIds)
            ]);
            if (!nextPlayers.length) {
                await deleteFirestoreDocument(this.env, sessionPath);
            } else {
                await patchFirestoreDocument(this.env, sessionPath, {
                    status: "lobby",
                    round: round + 1,
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
                    updatedAt: timestampNow()
                });
            }
            match.status = "cancelled";
            match.activePlayerIds = [];
            await this.saveMatch(match);
            return { left: true, finished: false, cancelledRound: true };
        }

        match.activePlayerIds = nextRoster;
        match.hands[uid] = [];
        match.handCounts[uid] = 0;
        if (match.unoPendingUid === uid) {
            match.unoPendingUid = null;
            match.unoCalled = false;
        }

        const nextCurrent = nextRemaining(
            match.playerIds,
            nextRoster,
            match.currentPlayerUid,
            match.direction,
            match.currentPlayerIndex
        );
        const winner = nextRoster.length === 1 ? nextRoster[0] : null;
        const currentChanged = nextCurrent !== match.currentPlayerUid;
        match.currentPlayerIndex = nextRoster.indexOf(winner || nextCurrent);
        match.currentPlayerUid = winner || nextCurrent;
        match.drewCardId = null;
        if (winner) {
            match.status = "results";
            match.winnerId = winner;
            match.unoPendingUid = null;
            match.unoCalled = false;
            match.finishedAt = changedAt;
        } else if (currentChanged) {
            match.turnNumber += 1;
            match.turnStartedAt = changedAt;
        }

        const sessionPatch = {
            status: winner ? "results" : "playing",
            hostId: nextHost || nextRoster[0],
            playerIds: nextLobby,
            readyIds: [],
            matchPlayerIds: nextRoster,
            resultReturnIds: [],
            finishedAt: winner ? firestoreTimestamp(new Date(changedAt)) : null,
            updatedAt: timestampNow()
        };
        await patchFirestoreDocument(this.env, sessionPath, sessionPatch);
        await this.saveMatch(match);
        if (winner) await this.syncFinishedResult(match);

        return { left: true, finished: Boolean(winner), winner };
    }

    async reconcileRoster(uid) {
        const { roomId, round } = await this.getIdentity();
        const match = await this.loadMatch(false);
        if (!match || match.status !== "playing") return { reconciled: false };

        const sessionDoc = await getFirestoreDocument(
            this.env,
            "rooms/" + roomId + "/gameSessions/active"
        );
        if (!sessionDoc || Number(sessionDoc.data.round) !== round ||
            sessionDoc.data.status !== "playing") return { reconciled: false };

        const allowed = getSessionPlayers(sessionDoc.data);
        if (!allowed.includes(uid)) return { reconciled: false };
        const nextRoster = match.activePlayerIds.filter((id) => allowed.includes(id));
        if (
            nextRoster.length === match.activePlayerIds.length &&
            nextRoster.every((id, index) => id === match.activePlayerIds[index])
        ) {
            return { reconciled: false };
        }
        if (!nextRoster.length) throw new Error("UNO maçında aktif oyuncu kalmadı.");

        const nextCurrent = nextRemaining(
            match.activePlayerIds,
            nextRoster,
            match.currentPlayerUid,
            match.direction,
            match.currentPlayerIndex
        );
        const winner = nextRoster.length === 1 ? nextRoster[0] : null;
        const currentChanged = nextCurrent !== match.currentPlayerUid;
        match.activePlayerIds = nextRoster;
        match.currentPlayerIndex = nextRoster.indexOf(winner || nextCurrent);
        match.currentPlayerUid = winner || nextCurrent;
        match.drewCardId = null;
        if (winner) {
            match.status = "results";
            match.winnerId = winner;
            match.finishedAt = Date.now();
            match.unoPendingUid = null;
            match.unoCalled = false;
        } else if (currentChanged) {
            match.turnNumber += 1;
            match.turnStartedAt = Date.now();
        }
        await this.saveMatch(match);
        if (winner) await this.syncFinishedResult(match);
        return { reconciled: true, finished: Boolean(winner), winner };
    }

    async returnToLobby(uid) {
        const { roomId, round } = await this.getIdentity();
        const match = await this.loadMatch(false);
        if (!match || match.status !== "results") {
            throw new Error("UNO sonuçları henüz hazır değil.");
        }
        if (!match.activePlayerIds.includes(uid)) {
            throw new Error("Bu oyuncu sonuç ekranında aktif değil.");
        }
        await this.syncFinishedResult(match);

        const sessionPath = "rooms/" + roomId + "/gameSessions/active";
        const sessionDoc = await getFirestoreDocument(this.env, sessionPath);
        if (!sessionDoc || Number(sessionDoc.data.round) !== round ||
            sessionDoc.data.status !== "results") {
            throw new Error("Firebase oyun lobisi sonuç aşamasında değil.");
        }

        const session = sessionDoc.data;
        const players = [...match.activePlayerIds];
        const returned = uniqueIds(match.returnedIds);
        if (!returned.includes(uid)) returned.push(uid);
        match.returnedIds = returned;

        const allReturned = players.length > 0 && players.every((id) => returned.includes(id));
        if (!allReturned) {
            await patchFirestoreDocument(this.env, sessionPath, {
                resultReturnIds: returned,
                updatedAt: timestampNow()
            });
            await patchFirestoreDocument(
                this.env,
                "rooms/" + roomId + "/unoResults/" + String(round),
                { resultReturnIds: returned }
            );
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
            throw new Error("Sonraki UNO lobisi 10 oyuncu sınırını aşıyor.");
        }
        const nextHost = nextPlayers.includes(session.hostId)
            ? session.hostId
            : nextPlayers[0];

        await patchFirestoreDocument(this.env, sessionPath, {
            status: "lobby",
            round: round + 1,
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
            updatedAt: timestampNow()
        });
        await patchFirestoreDocument(
            this.env,
            "rooms/" + roomId + "/unoResults/" + String(round),
            {
                resultReturnIds: returned,
                returnedAt: timestampNow(),
                lobbyRound: round + 1
            }
        );
        await this.ctx.storage.put("match", match);
        await this.ctx.storage.deleteAlarm();

        return {
            completed: true,
            round: round + 1,
            returnedCount: players.length,
            requiredCount: players.length
        };
    }

    async alarm() {
        return this.enqueue(async () => {
            const match = await this.loadMatch(false);
            if (!match || match.status !== "playing") return;
            if (Date.now() - match.turnStartedAt < TURN_TIMEOUT_MS) {
                await this.scheduleTurnAlarm(match);
                return;
            }

            const next = nextPlayerIndex(
                match.currentPlayerIndex,
                match.direction,
                match.activePlayerIds.length,
                1
            );
            this.advanceTurn(match, next, match.direction);
            await this.saveMatch(match);
        });
    }
}
