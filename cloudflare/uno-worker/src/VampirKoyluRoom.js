import { DurableObject } from "cloudflare:workers";
import {
    assignRoles,
    getWinningTeam,
    resolveNight,
    resolveVote
} from "../../../games/vampir-koylu/engine.js";
import {
    chooseBotDoctorTarget,
    chooseBotVote,
    chooseBotVampireTarget,
    createBotDiscussionLine,
    createMatchRoster
} from "../../../games/vampir-koylu/bots.js";
import {
    deleteFirestoreDocument,
    firestoreTimestamp,
    getFirestoreDocument,
    patchFirestoreDocument
} from "./firebase.js";

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 12;
const NIGHT_MS = 25_000;
const DISCUSSION_MS = 45_000;
const VOTING_MS = 20_000;

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

function timestampNow() {
    return firestoreTimestamp(new Date());
}

function secureRandom() {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return value[0] / 0x1_0000_0000;
}

function getPublicState(match) {
    const revealedRoles = {};
    for (const uid of match.playerIds) {
        if (match.status === "results" || !match.activePlayerIds.includes(uid)) {
            revealedRoles[uid] = match.roles[uid];
        }
    }

    return {
        roomId: match.roomId,
        round: match.round,
        status: match.status,
        phase: match.phase,
        dayNumber: match.dayNumber,
        playerIds: match.playerIds,
        alivePlayerIds: match.activePlayerIds,
        botNames: match.botNames || {},
        revealedRoles,
        phaseEndsAt: match.phaseEndsAt,
        publicMessage: match.publicMessage,
        discussionMessages: match.discussionMessages || [],
        winnerTeam: match.winnerTeam,
        votesSubmitted: Object.keys(match.votes || {}).length,
        votesRequired: match.phase === "voting" ? match.activePlayerIds.length : 0,
        finishedAt: match.finishedAt
    };
}

function getPrivateState(match, uid) {
    if (!match.playerIds.includes(uid)) return null;
    const role = match.roles[uid];
    const vampireTeammates = role === "vampir"
        ? match.playerIds.filter((id) =>
            id !== uid &&
            match.activePlayerIds.includes(id) &&
            match.roles[id] === "vampir"
        )
        : [];

    let selectedTargetUid = null;
    let hasActed = false;
    if (match.phase === "night" && role === "vampir") {
        selectedTargetUid = match.nightActions.vampireTargets[uid] || null;
        hasActed = Boolean(selectedTargetUid);
    } else if (match.phase === "night" && role === "doktor") {
        selectedTargetUid = match.nightActions.doctorTarget || null;
        hasActed = Boolean(selectedTargetUid);
    } else if (match.phase === "voting") {
        selectedTargetUid = match.votes[uid] || null;
        hasActed = Boolean(selectedTargetUid);
    }

    return {
        role,
        vampireTeammates,
        selectedTargetUid,
        hasActed,
        alive: match.activePlayerIds.includes(uid)
    };
}

export class VampirKoyluRoom extends DurableObject {
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
        const round = Number(headers.get("X-CACA-ROUND"));
        if (
            !/^[A-Za-z0-9_-]{1,128}$/.test(roomId) ||
            !Number.isInteger(round) ||
            round < 1
        ) {
            throw new Error("Oda veya tur bilgisi geçersiz.");
        }

        const current = await this.ctx.storage.get("identity");
        if (current && (current.roomId !== roomId || current.round !== round)) {
            throw new Error("Vampir Köylü oda kimliği eşleşmiyor.");
        }
        await this.ctx.storage.put("identity", { roomId, round });
        return { roomId, round };
    }

    async getIdentity() {
        const identity = await this.ctx.storage.get("identity");
        if (!identity) throw new Error("Oyun oda kimliği henüz başlatılmadı.");
        return identity;
    }

    async schedulePhaseAlarm(match) {
        if (match.status === "playing" && Number.isFinite(match.phaseEndsAt)) {
            await this.ctx.storage.setAlarm(match.phaseEndsAt);
        } else {
            await this.ctx.storage.deleteAlarm();
        }
    }

    async saveMatch(match, broadcast = true) {
        await this.ctx.storage.put("match", match);
        await this.schedulePhaseAlarm(match);
        if (broadcast) this.broadcastState(match);
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
            session.gameId !== "vampir-koylu" ||
            session.status !== "playing" ||
            Number(session.round) !== round
        ) {
            throw new Error("Vampir Köylü maçı başlatılmaya hazır değil.");
        }

        const humanPlayers = getSessionPlayers(session);
        const roster = createMatchRoster(humanPlayers, session.gameSettings || {}, round);
        const botPlayerIds = roster.botPlayerIds;
        const botNames = roster.botNames;
        const players = roster.playerIds;
        if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
            throw new Error("Vampir Köylü toplam 5–12 oyuncu ile oynanır.");
        }

        const now = Date.now();
        const match = {
            roomId,
            round,
            status: "playing",
            phase: "night",
            dayNumber: 1,
            playerIds: [...players],
            humanPlayerIds: [...humanPlayers],
            botPlayerIds,
            botNames,
            botLastMessageDay: {},
            botLastMessageAt: 0,
            lastDoctorTargets: [],
            voteHistory: [],
            activePlayerIds: [...players],
            roles: assignRoles(players, secureRandom),
            revealedRoles: {},
            nightActions: {
                vampireTargets: {},
                doctorTarget: null
            },
            votes: {},
            phaseEndsAt: now + NIGHT_MS,
            publicMessage: "Gece oldu. Vampirler ve doktor gizli seçimlerini yapıyor.",
            discussionMessages: [],
            discussionLastMessageAt: {},
            winnerTeam: null,
            finishedAt: null,
            returnedIds: [],
            firebaseResultSynced: false,
            createdAt: now
        };

        await this.runBotNightActions(match);
        await this.maybeResolveCurrentPhase(match);
        await this.ctx.storage.put("match", match);
        await this.schedulePhaseAlarm(match);
        return match;
    }

    send(socket, payload) {
        try {
            socket.send(JSON.stringify(payload));
        } catch {
            // A disconnected browser will reconnect and receive a fresh snapshot.
        }
    }

    sendSnapshot(socket, match) {
        const attachment = socket.deserializeAttachment();
        const uid = attachment?.uid;
        this.send(socket, { type: "state", state: getPublicState(match) });
        if (attachment?.role === "player") {
            this.send(socket, {
                type: "private",
                privateState: getPrivateState(match, uid)
            });
        }
    }

    broadcastState(match) {
        for (const socket of this.ctx.getWebSockets()) {
            if (!socket.deserializeAttachment()?.uid) continue;
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
            return new Response(error.message || "Oyun kimliği geçersiz.", { status: 400 });
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
                throw new Error("Vampir Köylü turu artık etkin değil.");
            }

            const currentPlayers = getSessionPlayers(session);
            const spectators = uniqueIds(session.spectatorIds);
            const validPlayer = role === "player" &&
                currentPlayers.includes(uid) &&
                match.playerIds.includes(uid);
            const validSpectator = role === "spectator" && spectators.includes(uid);
            if (!validPlayer && !validSpectator) {
                throw new Error("Bu maç için bağlantı iznin yok.");
            }

            if (match.status === "results") await this.syncFinishedResult(match);
        } catch (error) {
            return new Response(error.message || "Vampir Köylü bağlantısı kurulamadı.", { status: 403 });
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
        const requestId = command?.requestId || null;
        if (!uid || attachment?.role !== "player") {
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
            if (!match || match.status !== "playing") {
                throw new Error("Vampir Köylü maçı devam etmiyor.");
            }

            const { roomId, round } = await this.getIdentity();
            const sessionDoc = await getFirestoreDocument(
                this.env,
                "rooms/" + roomId + "/gameSessions/active"
            );
            const session = sessionDoc?.data;
            if (
                !session ||
                session.gameId !== "vampir-koylu" ||
                session.status !== "playing" ||
                Number(session.round) !== round ||
                !getSessionPlayers(session).includes(uid) ||
                !match.playerIds.includes(uid)
            ) {
                throw new Error("Bu maçta artık aktif bir katılımcı değilsin.");
            }

            let result;
            if (command.type === "nightAction") {
                result = this.chooseNightTarget(match, uid, command.targetUid);
            } else if (command.type === "vote") {
                result = this.castVote(match, uid, command.targetUid);
            } else if (command.type === "sendMessage") {
                result = this.sendDiscussionMessage(match, uid, command.text);
                await this.runBotDiscussion(match, true);
            } else if (command.type === "ping") {
                result = { pong: true };
            } else {
                throw new Error("Bilinmeyen Vampir Köylü hamlesi.");
            }

            await this.runBotsForCurrentPhase(match);
            await this.maybeResolveCurrentPhase(match);
            await this.saveMatch(match);
            if (match.status === "results") {
                try {
                    await this.syncFinishedResult(match);
                } catch {
                    // The result remains durable and is synced again on reconnect or return.
                }
            }
            this.send(socket, { type: "actionResult", requestId, ok: true, result });
        } catch (error) {
            this.send(socket, {
                type: "actionResult",
                requestId,
                ok: false,
                error: error?.message || "Hamle tamamlanamadı."
            });
        }
    }

    requireAlive(match, uid) {
        if (
            match.status !== "playing" ||
            !match.activePlayerIds.includes(uid) ||
            !match.playerIds.includes(uid)
        ) {
            throw new Error("Bu oyunda artık hayatta değilsin.");
        }
    }

    getLivingBotIds(match) {
        const botIds = new Set(match.botPlayerIds || []);
        return match.activePlayerIds.filter((id) => botIds.has(id));
    }

    async runBotNightActions(match, force = false) {
        if (match.status !== "playing" || match.phase !== "night") return;

        const aliveBots = this.getLivingBotIds(match);
        const botIds = new Set(match.botPlayerIds || []);
        const aliveVampires = match.activePlayerIds.filter((id) => match.roles[id] === "vampir");
        const humanVampires = aliveVampires.filter((id) => !botIds.has(id));
        const humanVampireStillChoosing = humanVampires.some((id) =>
            !match.nightActions.vampireTargets[id]
        );

        for (const botId of aliveBots) {
            const role = match.roles[botId];
            if (role === "vampir" && !match.nightActions.vampireTargets[botId]) {
                // Let a real vampire choose first so the bot can coordinate with
                // that choice instead of making an invisible random selection.
                if (humanVampireStillChoosing && !force) continue;
                const teammates = aliveVampires.filter((id) => id !== botId);
                const targetUid = chooseBotVampireTarget({
                    botId,
                    alivePlayerIds: match.activePlayerIds,
                    teammateIds: teammates,
                    vampireTargets: match.nightActions.vampireTargets,
                    random: secureRandom
                });
                if (targetUid) match.nightActions.vampireTargets[botId] = targetUid;
            } else if (role === "doktor" && !match.nightActions.doctorTarget) {
                const targetUid = chooseBotDoctorTarget({
                    botId,
                    alivePlayerIds: match.activePlayerIds,
                    previousVictims: match.lastDoctorTargets || [],
                    random: secureRandom
                });
                if (targetUid) match.nightActions.doctorTarget = targetUid;
            }
        }
    }

    async runBotVotes(match, force = false) {
        if (match.status !== "playing" || match.phase !== "voting") return;

        const aliveBots = this.getLivingBotIds(match);
        const botIds = new Set(match.botPlayerIds || []);
        const aliveVampires = match.activePlayerIds.filter((id) => match.roles[id] === "vampir");
        const humanVampires = aliveVampires.filter((id) => !botIds.has(id));
        const humanVampireStillVoting = humanVampires.some((id) => !match.votes[id]);
        for (const botId of aliveBots) {
            if (match.votes[botId]) continue;

            const role = match.roles[botId];
            if (role === "vampir" && humanVampireStillVoting && !force) continue;
            const teammateIds = role === "vampir"
                ? aliveVampires.filter((id) => id !== botId)
                : [];
            const targetUid = chooseBotVote({
                botId,
                role,
                alivePlayerIds: match.activePlayerIds,
                vampireTeammateIds: teammateIds,
                vampireVotes: match.votes,
                botNames: match.botNames || {},
                discussionMessages: match.discussionMessages || [],
                voteHistory: match.voteHistory || [],
                revealedRoles: match.revealedRoles || {},
                random: secureRandom
            });
            if (targetUid) match.votes[botId] = targetUid;
        }
    }

    async runBotDiscussion(match, replyToHuman = false) {
        if (match.status !== "playing" || match.phase !== "day") return;
        const aliveBots = this.getLivingBotIds(match);
        if (!aliveBots.length) return;

        if (!match.botLastMessageDay) match.botLastMessageDay = {};
        const eligible = aliveBots.filter((id) => match.botLastMessageDay[id] !== match.dayNumber);
        if (!eligible.length) {
            const lastAt = Number(match.botLastMessageAt) || 0;
            if (!replyToHuman || Date.now() - lastAt < 6500) return;
        }

        let speakers;
        if (replyToHuman) {
            const available = eligible.length ? eligible : aliveBots;
            speakers = [available[Math.floor(secureRandom() * available.length)]];
        } else {
            const count = Math.min(2, Math.max(1, Math.ceil(eligible.length / 3)));
            const shuffled = [...eligible];
            for (let index = shuffled.length - 1; index > 0; index -= 1) {
                const next = Math.floor(secureRandom() * (index + 1));
                [shuffled[index], shuffled[next]] = [shuffled[next], shuffled[index]];
            }
            speakers = shuffled.slice(0, count);
        }

        if (!Array.isArray(match.discussionMessages)) match.discussionMessages = [];
        for (const botId of speakers) {
            const role = match.roles[botId];
            const vampireTeammateIds = role === "vampir"
                ? match.activePlayerIds.filter((id) => id !== botId && match.roles[id] === "vampir")
                : [];
            const text = createBotDiscussionLine({
                role,
                botId,
                botNames: match.botNames || {},
                playerIds: match.activePlayerIds,
                vampireTeammateIds,
                discussionMessages: match.discussionMessages,
                random: secureRandom
            });
            if (!text) continue;

            match.discussionMessages.push({
                id: crypto.randomUUID(),
                uid: botId,
                text,
                dayNumber: match.dayNumber,
                createdAt: Date.now()
            });
            match.botLastMessageDay[botId] = match.dayNumber;
            match.botLastMessageAt = Date.now();
        }
        match.discussionMessages = match.discussionMessages.slice(-80);
    }

    async runBotsForCurrentPhase(match, force = false) {
        if (match.phase === "night") await this.runBotNightActions(match, force);
        else if (match.phase === "voting") await this.runBotVotes(match, force);
    }

    chooseNightTarget(match, uid, targetUid) {
        if (match.phase !== "night") throw new Error("Şu anda gece aşaması değil.");
        this.requireAlive(match, uid);
        if (typeof targetUid !== "string" || !match.activePlayerIds.includes(targetUid)) {
            throw new Error("Geçerli bir oyuncu seçmelisin.");
        }

        const role = match.roles[uid];
        if (role === "vampir") {
            if (match.roles[targetUid] === "vampir") {
                throw new Error("Vampirler kendi takımlarını hedef alamaz.");
            }
            match.nightActions.vampireTargets[uid] = targetUid;
            return { selected: true, action: "vampir-hedefi" };
        }
        if (role === "doktor") {
            match.nightActions.doctorTarget = targetUid;
            return { selected: true, action: "doktor-korumasi" };
        }
        throw new Error("Köylüler gece hamlesi yapamaz.");
    }

    castVote(match, uid, targetUid) {
        if (match.phase !== "voting") throw new Error("Şu anda oylama aşaması değil.");
        this.requireAlive(match, uid);
        if (
            typeof targetUid !== "string" ||
            !match.activePlayerIds.includes(targetUid) ||
            targetUid === uid
        ) {
            throw new Error("Kendine oy veremezsin. Hayatta olan başka bir oyuncu seç.");
        }
        match.votes[uid] = targetUid;
        return { submitted: true };
    }

    sendDiscussionMessage(match, uid, rawText) {
        if (match.phase !== "day") {
            throw new Error("Sohbet yalnızca gündüz aşamasında açık.");
        }
        this.requireAlive(match, uid);
        if (typeof rawText !== "string") throw new Error("Mesaj metni geçersiz.");
        const text = rawText.trim();
        if (!text || text.length > 400) {
            throw new Error("Mesaj 1–400 karakter arasında olmalı.");
        }

        const now = Date.now();
        const lastSentAt = Number(match.discussionLastMessageAt?.[uid]) || 0;
        if (now - lastSentAt < 900) {
            throw new Error("Mesaj göndermek için biraz beklemelisin.");
        }

        if (!match.discussionLastMessageAt) match.discussionLastMessageAt = {};
        if (!Array.isArray(match.discussionMessages)) match.discussionMessages = [];
        match.discussionLastMessageAt[uid] = now;
        match.discussionMessages.push({
            id: crypto.randomUUID(),
            uid,
            text,
            dayNumber: match.dayNumber,
            createdAt: now
        });
        match.discussionMessages = match.discussionMessages.slice(-80);
        return { sent: true };
    }

    async maybeResolveCurrentPhase(match) {
        if (match.status !== "playing") return;

        if (match.phase === "night") {
            const vampireIds = match.activePlayerIds.filter((uid) => match.roles[uid] === "vampir");
            const doctorId = match.activePlayerIds.find((uid) => match.roles[uid] === "doktor");
            const allVampiresActed = vampireIds.length > 0 &&
                vampireIds.every((uid) => Boolean(match.nightActions.vampireTargets[uid]));
            const doctorActed = !doctorId || Boolean(match.nightActions.doctorTarget);
            if (allVampiresActed && doctorActed) {
                await this.resolveNightPhase(match);
            }
        } else if (
            match.phase === "voting" &&
            match.activePlayerIds.length > 0 &&
            match.activePlayerIds.every((uid) => Boolean(match.votes[uid]))
        ) {
            await this.resolveVotingPhase(match);
        }
    }

    async beginDay(match, publicMessage) {
        match.phase = "day";
        match.publicMessage = publicMessage;
        match.phaseEndsAt = Date.now() + DISCUSSION_MS;
        if (!Array.isArray(match.discussionMessages)) match.discussionMessages = [];
        if (!match.discussionLastMessageAt) match.discussionLastMessageAt = {};
        match.votes = {};
        match.nightActions = { vampireTargets: {}, doctorTarget: null };
        await this.runBotDiscussion(match);
    }

    async beginNight(match, publicMessage = "Gece oldu. Vampirler ve doktor gizli seçimlerini yapıyor.") {
        match.phase = "night";
        match.phaseEndsAt = Date.now() + NIGHT_MS;
        match.nightActions = { vampireTargets: {}, doctorTarget: null };
        match.votes = {};
        match.publicMessage = publicMessage;
        await this.runBotNightActions(match);
        await this.maybeResolveCurrentPhase(match);
    }

    async startVotingPhase(match) {
        if (match.status !== "playing" || match.phase !== "day") return;
        const winner = getWinningTeam(match.activePlayerIds, match.roles);
        if (winner) {
            await this.finishMatch(
                match,
                winner,
                winner === "koyluler" ? "Son vampir de bulundu. Köylüler kazandı!" : "Vampirler köyün kontrolünü ele geçirdi!"
            );
            return;
        }

        match.phase = "voting";
        match.phaseEndsAt = Date.now() + VOTING_MS;
        match.votes = {};
        match.publicMessage = "Tartışma bitti. Şimdi köyden gönderilecek kişiyi oylayın.";
        await this.runBotVotes(match);
        await this.maybeResolveCurrentPhase(match);
    }

    async resolveNightPhase(match) {
        if (match.status !== "playing" || match.phase !== "night") return;

        const outcome = resolveNight(
            match.nightActions.vampireTargets,
            match.nightActions.doctorTarget,
            match.activePlayerIds,
            match.roles
        );
        if (match.nightActions.doctorTarget) {
            match.lastDoctorTargets = [
                ...(match.lastDoctorTargets || []),
                match.nightActions.doctorTarget
            ].slice(-3);
        }

        let message;
        if (outcome.victimUid) {
            match.activePlayerIds = match.activePlayerIds.filter((id) => id !== outcome.victimUid);
            match.revealedRoles[outcome.victimUid] = match.roles[outcome.victimUid];
            message = "Gece " + outcome.victimUid + " hayatını kaybetti.";
        } else if (outcome.saved) {
            message = "Doktor bu gece bir kişiyi kurtardı. Kimse ölmedi.";
        } else {
            message = "Bu gece kimse ölmedi.";
        }

        const winner = getWinningTeam(match.activePlayerIds, match.roles);
        if (winner) {
            await this.finishMatch(
                match,
                winner,
                winner === "koyluler"
                    ? "Son vampir de ortadan kaldırıldı. Köylüler kazandı!"
                    : "Vampirler köyün kontrolünü ele geçirdi!"
            );
            return;
        }

        match.dayNumber += 1;
        await this.beginDay(match, message);
    }

    async resolveVotingPhase(match) {
        if (match.status !== "playing" || match.phase !== "voting") return;

        const outcome = resolveVote(match.votes, match.activePlayerIds);
        if (!Array.isArray(match.voteHistory)) match.voteHistory = [];
        match.voteHistory.push({
            dayNumber: match.dayNumber,
            votes: { ...match.votes }
        });
        match.voteHistory = match.voteHistory.slice(-8);
        let message;
        if (outcome.targetUid) {
            match.activePlayerIds = match.activePlayerIds.filter((id) => id !== outcome.targetUid);
            match.revealedRoles[outcome.targetUid] = match.roles[outcome.targetUid];
            message = "Oylamayla " + outcome.targetUid + " köyden gönderildi.";
        } else if (outcome.tied) {
            message = "Oylama eşit bitti. Kimse köyden gönderilmedi.";
        } else {
            message = "Yeterli oy kullanılmadı. Kimse köyden gönderilmedi.";
        }

        const winner = getWinningTeam(match.activePlayerIds, match.roles);
        if (winner) {
            await this.finishMatch(
                match,
                winner,
                winner === "koyluler"
                    ? "Son vampir de bulundu. Köylüler kazandı!"
                    : "Vampirler köyün kontrolünü ele geçirdi!"
            );
            return;
        }

        await this.beginNight(
            match,
            message + " Yeni gece başladı. Vampirler ve doktor seçim yapıyor."
        );
    }

    async finishMatch(match, winnerTeam, publicMessage) {
        match.status = "results";
        match.phase = "results";
        match.phaseEndsAt = null;
        match.winnerTeam = winnerTeam;
        match.publicMessage = publicMessage;
        match.finishedAt = Date.now();
        match.revealedRoles = { ...match.roles };
        match.returnedIds = [];
    }

    async syncFinishedResult(match) {
        if (match.status !== "results" || match.firebaseResultSynced) return;

        const sessionPath = "rooms/" + match.roomId + "/gameSessions/active";
        const sessionDoc = await getFirestoreDocument(this.env, sessionPath);
        if (!sessionDoc || Number(sessionDoc.data.round) !== match.round) {
            throw new Error("Vampir Köylü sonucu Firebase oyun lobisine yazılamadı.");
        }

        if (sessionDoc.data.status === "playing") {
            await patchFirestoreDocument(this.env, sessionPath, {
                status: "results",
                readyIds: [],
                resultReturnIds: [],
                finishedAt: firestoreTimestamp(new Date(match.finishedAt)),
                updatedAt: timestampNow()
            });
        } else if (sessionDoc.data.status !== "results") {
            throw new Error("Vampir Köylü sonucu için Firebase oturum durumu geçersiz.");
        }

        match.firebaseResultSynced = true;
        await this.ctx.storage.put("match", match);
    }

    async handleHttpAction(request) {
        const uid = request.headers.get("X-CACA-UID") || "";
        const role = request.headers.get("X-CACA-ROLE") || "";
        if (!uid || role !== "player") {
            return Response.json({ error: "Bu işlem yalnızca maç oyuncularına açık." }, { status: 403 });
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
                return Response.json({ error: "Bilinmeyen Vampir Köylü işlemi." }, { status: 400 });
            }
            return Response.json(result);
        } catch (error) {
            return Response.json(
                { error: error?.message || "Vampir Köylü işlemi tamamlanamadı." },
                { status: 400 }
            );
        }
    }

    async cancelBeforeStart(uid, session) {
        const { roomId, round } = await this.getIdentity();
        const sessionPath = "rooms/" + roomId + "/gameSessions/active";
        const players = uniqueIds(session.playerIds);
        const matchPlayers = getSessionPlayers(session);
        if (!players.includes(uid) || !matchPlayers.includes(uid)) {
            return { left: false, reason: "not-active" };
        }

        const remainingPlayers = players.filter((id) => id !== uid);
        const nextPlayers = uniqueIds([
            ...remainingPlayers,
            ...uniqueIds(session.spectatorIds),
            ...uniqueIds(session.nextRoundPlayerIds)
        ]);
        if (!nextPlayers.length) {
            await deleteFirestoreDocument(this.env, sessionPath);
            return { left: true, cancelledBeforeStart: true };
        }

        const nextHost = session.hostId === uid
            ? nextPlayers[0]
            : (nextPlayers.includes(session.hostId) ? session.hostId : nextPlayers[0]);
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
        return { left: true, cancelledBeforeStart: true };
    }

    async quitPlayer(uid) {
        const { roomId, round } = await this.getIdentity();
        const sessionPath = "rooms/" + roomId + "/gameSessions/active";
        const sessionDoc = await getFirestoreDocument(this.env, sessionPath);
        if (
            !sessionDoc ||
            sessionDoc.data.gameId !== "vampir-koylu" ||
            Number(sessionDoc.data.round) !== round ||
            !["playing", "results"].includes(sessionDoc.data.status)
        ) {
            throw new Error("Bu Vampir Köylü turu artık aktif değil.");
        }

        const session = sessionDoc.data;
        const participantIds = getSessionPlayers(session);
        if (!participantIds.includes(uid)) return { left: false, reason: "not-active" };

        const match = await this.loadMatch(false);
        if (!match) return this.cancelBeforeStart(uid, session);

        const nextPlayers = uniqueIds(session.playerIds).filter((id) => id !== uid);
        const nextMatchPlayers = participantIds.filter((id) => id !== uid);
        const nextHost = session.hostId === uid
            ? (nextPlayers[0] || nextMatchPlayers[0] || "")
            : session.hostId;

        match.playerIds = match.playerIds.filter((id) => id !== uid);
        match.humanPlayerIds = (match.humanPlayerIds || []).filter((id) => id !== uid);
        match.activePlayerIds = match.activePlayerIds.filter((id) => id !== uid);
        delete match.nightActions.vampireTargets[uid];
        if (match.votes) delete match.votes[uid];
        match.returnedIds = uniqueIds(match.returnedIds).filter((id) => id !== uid);

        if (!nextMatchPlayers.length) {
            const nextLobbyPlayers = uniqueIds([
                ...nextPlayers,
                ...uniqueIds(session.spectatorIds),
                ...uniqueIds(session.nextRoundPlayerIds)
            ]);
            if (!nextLobbyPlayers.length) {
                await deleteFirestoreDocument(this.env, sessionPath);
            } else {
                await patchFirestoreDocument(this.env, sessionPath, {
                    status: "lobby",
                    round: round + 1,
                    hostId: nextLobbyPlayers.includes(nextHost) ? nextHost : nextLobbyPlayers[0],
                    playerIds: nextLobbyPlayers,
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
            match.phase = "cancelled";
            match.activePlayerIds = [];
            await this.saveMatch(match);
            return { left: true, finished: false, cancelledRound: true };
        }

        if (match.status === "results") {
            const returned = uniqueIds(match.returnedIds);
            const allReturned = nextMatchPlayers.every((id) => returned.includes(id));
            if (allReturned) {
                const nextLobbyPlayers = uniqueIds([
                    ...nextPlayers,
                    ...uniqueIds(session.spectatorIds),
                    ...uniqueIds(session.nextRoundPlayerIds)
                ]);
                await patchFirestoreDocument(this.env, sessionPath, {
                    status: "lobby",
                    round: round + 1,
                    hostId: nextLobbyPlayers.includes(nextHost) ? nextHost : nextLobbyPlayers[0],
                    playerIds: nextLobbyPlayers,
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
                await this.ctx.storage.put("match", match);
                return { left: true, finished: true };
            }
            await patchFirestoreDocument(this.env, sessionPath, {
                playerIds: nextPlayers,
                matchPlayerIds: nextMatchPlayers,
                resultReturnIds: returned,
                hostId: nextHost || nextPlayers[0],
                updatedAt: timestampNow()
            });
            await this.ctx.storage.put("match", match);
            return { left: true, finished: true };
        }

        const winner = getWinningTeam(match.activePlayerIds, match.roles);
        if (winner) {
            await this.finishMatch(
                match,
                winner,
                winner === "koyluler"
                    ? "Oyuncu ayrıldıktan sonra köylüler kazandı!"
                    : "Oyuncu ayrıldıktan sonra vampirler kazandı!"
            );
        } else if (match.activePlayerIds.length === 0) {
            await this.finishMatch(match, null, "Oyuncu kalmadığı için maç sona erdi.");
        }

        await patchFirestoreDocument(this.env, sessionPath, {
            status: match.status === "results" ? "results" : "playing",
            hostId: nextHost || nextPlayers[0],
            playerIds: nextPlayers,
            matchPlayerIds: nextMatchPlayers,
            readyIds: [],
            resultReturnIds: match.status === "results" ? [] : uniqueIds(session.resultReturnIds),
            finishedAt: match.status === "results"
                ? firestoreTimestamp(new Date(match.finishedAt))
                : null,
            updatedAt: timestampNow()
        });

        if (match.status === "playing") {
            await this.maybeResolveCurrentPhase(match);
        }
        await this.saveMatch(match);
        if (match.status === "results") {
            try {
                await this.syncFinishedResult(match);
            } catch {
                // A reconnect will retry result synchronization.
            }
        }
        return {
            left: true,
            finished: match.status === "results",
            winner: match.winnerTeam
        };
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
        const botIds = new Set(match.botPlayerIds || []);
        const nextRoster = match.playerIds.filter((id) => botIds.has(id) || allowed.includes(id));
        if (
            nextRoster.length === match.playerIds.length &&
            nextRoster.every((id, index) => id === match.playerIds[index])
        ) {
            return { reconciled: false };
        }

        const removed = match.playerIds.filter((id) => !botIds.has(id) && !allowed.includes(id));
        match.humanPlayerIds = (match.humanPlayerIds || []).filter((id) => allowed.includes(id));
        match.playerIds = nextRoster;
        match.activePlayerIds = match.activePlayerIds.filter((id) => botIds.has(id) || allowed.includes(id));
        for (const removedUid of removed) {
            delete match.nightActions.vampireTargets[removedUid];
            delete match.votes[removedUid];
            delete match.roles[removedUid];
            delete match.revealedRoles[removedUid];
        }
        if (match.nightActions.doctorTarget && !match.activePlayerIds.includes(match.nightActions.doctorTarget)) {
            match.nightActions.doctorTarget = null;
        }

        if (!match.activePlayerIds.length) {
            match.status = "cancelled";
            match.phase = "cancelled";
            match.phaseEndsAt = null;
            await this.ctx.storage.put("match", match);
            await this.ctx.storage.deleteAlarm();
            return { reconciled: true, cancelled: true };
        }

        const winner = getWinningTeam(match.activePlayerIds, match.roles);
        if (winner) {
            await this.finishMatch(
                match,
                winner,
                winner === "koyluler"
                    ? "Oda yönetimi oyuncu çıkardığı için köylüler kazandı!"
                    : "Oda yönetimi oyuncu çıkardığı için vampirler kazandı!"
            );
        } else {
            await this.maybeResolveCurrentPhase(match);
        }

        await this.saveMatch(match);
        if (match.status === "results") {
            try {
                await this.syncFinishedResult(match);
            } catch {
                // A reconnect will retry result synchronization.
            }
        }
        return { reconciled: true };
    }

    async returnToLobby(uid) {
        const { roomId, round } = await this.getIdentity();
        const match = await this.loadMatch(false);
        if (!match || match.status !== "results") {
            throw new Error("Vampir Köylü sonuç ekranı artık etkin değil.");
        }
        await this.syncFinishedResult(match);

        const sessionPath = "rooms/" + roomId + "/gameSessions/active";
        const sessionDoc = await getFirestoreDocument(this.env, sessionPath);
        if (!sessionDoc || Number(sessionDoc.data.round) !== round ||
            sessionDoc.data.status !== "results") {
            throw new Error("Firebase oyun lobisi sonuç aşamasında değil.");
        }

        const session = sessionDoc.data;
        const players = getSessionPlayers(session);
        if (!players.includes(uid)) {
            throw new Error("Bu oyuncu sonuç ekranında aktif değil.");
        }

        const returned = uniqueIds(match.returnedIds);
        if (!returned.includes(uid)) returned.push(uid);
        match.returnedIds = returned;
        const allReturned = players.length > 0 && players.every((id) => returned.includes(id));

        if (!allReturned) {
            await patchFirestoreDocument(this.env, sessionPath, {
                resultReturnIds: returned,
                updatedAt: timestampNow()
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
            throw new Error("Sonraki Vampir Köylü lobisi 12 oyuncu sınırını aşıyor.");
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
            if (Date.now() < match.phaseEndsAt) {
                await this.schedulePhaseAlarm(match);
                return;
            }

            if (match.phase === "night") {
                await this.runBotNightActions(match, true);
                await this.maybeResolveCurrentPhase(match);
                if (match.status === "playing" && match.phase === "night") {
                    await this.resolveNightPhase(match);
                }
            } else if (match.phase === "day") {
                await this.startVotingPhase(match);
            } else if (match.phase === "voting") {
                await this.runBotVotes(match, true);
                await this.maybeResolveCurrentPhase(match);
                if (match.status === "playing" && match.phase === "voting") {
                    await this.resolveVotingPhase(match);
                }
            }

            await this.saveMatch(match);
            if (match.status === "results") {
                try {
                    await this.syncFinishedResult(match);
                } catch {
                    // A reconnect will retry result synchronization.
                }
            }
        });
    }
}
