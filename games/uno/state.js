import {
    arrayUnion, deleteDoc, doc, onSnapshot, runTransaction, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { createUnoDeck, shuffleDeck } from "./deck.js";
import { UNO_COLORS, getPlayEffect, isCardPlayable, nextPlayerIndex } from "./engine.js";

const MAX_PLAYERS = 10;
const HAND_SIZE = 7;
const DEFAULT_TIMEOUT = 90_000;

const sessionRef = (db, roomId) => doc(db, "rooms", roomId, "gameSessions", "active");
const matchRef = (db, roomId, round) => doc(db, "rooms", roomId, "unoMatches", String(round));
const handRef = (db, roomId, round, uid) =>
    doc(db, "rooms", roomId, "unoMatches", String(round), "hands", uid);

function ids(values) {
    return [...new Set(Array.isArray(values)
        ? values.filter((value) => typeof value === "string" && value)
        : [])];
}

function matchPlayers(session) {
    return ids(Array.isArray(session?.matchPlayerIds) ? session.matchPlayerIds : session?.playerIds);
}

function returnedPlayers(session) {
    return ids(session?.resultReturnIds);
}

function requireActive(state, uid) {
    if (state?.status !== "playing") throw new Error("Bu UNO maçı artık devam etmiyor.");
    if (!Array.isArray(state.activePlayerIds) || !state.activePlayerIds.includes(uid)) {
        throw new Error("Bu maçın aktif oyuncusu değilsin.");
    }
}

function requireTurn(state, uid) {
    requireActive(state, uid);
    if (state.currentPlayerUid !== uid) throw new Error("Sıra sende değil.");
}

function nextIndex(state, index, direction, steps = 1) {
    return nextPlayerIndex(index, direction, state.activePlayerIds.length, steps);
}

function makeInitialState(roomId, round, players, dealerId, drawPile, topCard) {
    return {
        roomId,
        round,
        status: "playing",
        playerIds: [...players],
        activePlayerIds: [...players],
        dealerId,
        direction: 1,
        currentPlayerIndex: 0,
        currentPlayerUid: players[0],
        activeColor: topCard.color,
        topCard,
        discardPile: [topCard],
        drawPile: [...drawPile],
        handCounts: Object.fromEntries(players.map((uid) => [uid, HAND_SIZE])),
        drewCardId: null,
        unoPendingUid: null,
        unoCalled: false,
        winnerId: null,
        forfeitedBy: null,
        turnNumber: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        turnStartedAt: serverTimestamp()
    };
}

function takeCards(state, count, discardPile = state.discardPile || [state.topCard]) {
    let drawPile = Array.isArray(state.drawPile) ? [...state.drawPile] : [];
    let discard = [...discardPile];

    if (drawPile.length < count) {
        const top = discard[discard.length - 1] || null;
        drawPile = drawPile.concat(shuffleDeck(discard.slice(0, -1)));
        discard = top ? [top] : [];
    }

    return { cards: drawPile.splice(0, count), drawPile, discardPile: discard };
}

function nextRemaining(previous, remaining, currentUid, direction, fallbackIndex = 0) {
    if (!remaining.length) return null;
    if (remaining.includes(currentUid)) return currentUid;
    const list = ids(previous);
    if (!list.length) return remaining[0];

    const index = Math.max(0, Math.min(Number(fallbackIndex) || 0, list.length - 1));
    for (let step = 1; step <= list.length; step += 1) {
        const offset = direction === -1 ? -step : step;
        const candidate = list[(index + offset + list.length * 2) % list.length];
        if (remaining.includes(candidate)) return candidate;
    }
    return remaining[0];
}

function nextTurn(state, index, direction, extra = {}) {
    const safeIndex = nextIndex(state, index, direction, 0);
    return {
        currentPlayerIndex: safeIndex,
        currentPlayerUid: state.activePlayerIds[safeIndex],
        direction,
        drewCardId: null,
        turnNumber: (Number(state.turnNumber) || 0) + 1,
        turnStartedAt: serverTimestamp(),
        ...extra
    };
}

function clearUno(state) {
    return state.unoPendingUid ? { unoPendingUid: null, unoCalled: false } : {};
}

function validStartSession(session, round, uid) {
    const players = matchPlayers(session);
    return session?.gameId === "uno" &&
        session.status === "playing" &&
        Number(session.round) === Number(round) &&
        players.length >= 2 &&
        players.length <= MAX_PLAYERS &&
        players.includes(uid);
}

/**
 * One transaction per player at round start: create the match once, and let
 * every player create only their own private hand. Missing-hand recovery is
 * serialized through the shared match document.
 */
export async function ensureMatch(db, roomId, round, uid) {
    return runTransaction(db, async (tx) => {
        const sRef = sessionRef(db, roomId);
        const gRef = matchRef(db, roomId, round);
        const hRef = handRef(db, roomId, round, uid);
        const [sSnap, gSnap, hSnap] = await Promise.all([
            tx.get(sRef), tx.get(gRef), tx.get(hRef)
        ]);

        if (!sSnap.exists()) throw new Error("Kalıcı oyun lobisi bulunamadı.");
        const session = sSnap.data();
        const players = matchPlayers(session);
        if (!validStartSession(session, round, uid)) {
            throw new Error("UNO maçı başlatılmaya hazır değil.");
        }

        if (gSnap.exists()) {
            const state = gSnap.data();
            if (
                state.roomId !== roomId ||
                Number(state.round) !== Number(round) ||
                !["playing", "results"].includes(state.status)
            ) {
                throw new Error("Bu tur için geçersiz veya eski bir UNO maç kaydı bulundu.");
            }
            if (state.status === "results") return state;
            if (!state.activePlayerIds?.includes(uid)) {
                throw new Error("Bu turda aktif oyuncu değilsin.");
            }
            if (hSnap.exists()) return state;

            const draw = takeCards(state, HAND_SIZE);
            if (draw.cards.length !== HAND_SIZE) {
                throw new Error("Oyuncunun başlangıç eli dağıtılamadı.");
            }
            const handCounts = { ...(state.handCounts || {}), [uid]: HAND_SIZE };
            tx.update(gRef, {
                drawPile: draw.drawPile,
                discardPile: draw.discardPile,
                handCounts,
                updatedAt: serverTimestamp()
            });
            tx.set(hRef, {
                cards: draw.cards,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            return { ...state, ...draw, handCounts };
        }

        if (hSnap.exists()) {
            throw new Error("Oyuncu eli var ancak maç kaydı bulunamadı.");
        }

        const deck = shuffleDeck(createUnoDeck());
        const openingHand = deck.splice(0, HAND_SIZE);
        const topIndex = deck.findIndex((card) => card.type === "number");
        if (openingHand.length !== HAND_SIZE || topIndex < 0) {
            throw new Error("UNO destesi hazırlanamadı.");
        }
        const [topCard] = deck.splice(topIndex, 1);
        const state = makeInitialState(roomId, round, players, uid, deck, topCard);

        tx.set(gRef, state);
        tx.set(hRef, {
            cards: openingHand,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        return state;
    });
}

export async function playCard(db, roomId, round, uid, cardId, selectedColor = null) {
    return runTransaction(db, async (tx) => {
        const gRef = matchRef(db, roomId, round);
        const hRef = handRef(db, roomId, round, uid);
        const [gSnap, hSnap] = await Promise.all([tx.get(gRef), tx.get(hRef)]);
        if (!gSnap.exists() || !hSnap.exists()) throw new Error("Maç veya oyuncu eli bulunamadı.");

        const state = gSnap.data();
        requireTurn(state, uid);
        const hand = Array.isArray(hSnap.data().cards) ? hSnap.data().cards : [];
        const card = hand.find((item) => item.id === cardId);
        if (!card) throw new Error("Bu kart elinde bulunmuyor.");
        if (state.drewCardId && state.drewCardId !== card.id) {
            throw new Error("Kart çektikten sonra yalnızca çektiğin kartı oynayabilirsin.");
        }
        if (!isCardPlayable(card, state.topCard, state.activeColor, hand)) {
            throw new Error(card.type === "wild4"
                ? "+4 kartı, elinde aktif renkten kart yoksa oynanabilir."
                : "Bu kart mevcut renkle veya kart sembolüyle eşleşmiyor.");
        }

        const wild = card.type === "wild" || card.type === "wild4";
        if (wild && !UNO_COLORS.includes(selectedColor)) {
            throw new Error("Renk değiştirme kartı için bir renk seçmelisin.");
        }
        if (!wild && selectedColor !== null) throw new Error("Normal kartlarda renk seçilemez.");

        const remainingHand = hand.filter((item) => item.id !== card.id);
        const winning = remainingHand.length === 0;
        const effect = getPlayEffect(card, state.activePlayerIds.length, state.direction);
        const discardAfterPlay = [...(state.discardPile || [state.topCard]), card];
        let drawPile = [...(state.drawPile || [])];
        let discardPile = discardAfterPlay;
        const handCounts = { ...(state.handCounts || {}), [uid]: remainingHand.length };
        let direction = effect.direction;
        let next = nextIndex(state, state.currentPlayerIndex, direction, effect.steps);
        let targetRef = null;
        let targetCards = null;

        if (effect.drawCount) {
            const targetIndex = nextIndex(
                state, state.currentPlayerIndex, state.direction, effect.targetIndexOffset
            );
            const targetUid = state.activePlayerIds[targetIndex];
            targetRef = handRef(db, roomId, round, targetUid);
            const targetSnap = await tx.get(targetRef);
            if (!targetSnap.exists()) throw new Error("Hedef oyuncunun eli henüz hazır değil.");

            targetCards = Array.isArray(targetSnap.data().cards) ? targetSnap.data().cards : [];
            const draw = takeCards(state, effect.drawCount, discardAfterPlay);
            drawPile = draw.drawPile;
            discardPile = draw.discardPile;
            handCounts[targetUid] = targetCards.length + draw.cards.length;
            targetCards = [...targetCards, ...draw.cards];
            next = nextIndex(state, targetIndex, state.direction, 1);
            direction = state.direction;
        }

        tx.update(hRef, { cards: remainingHand, updatedAt: serverTimestamp() });
        if (targetRef) {
            tx.update(targetRef, { cards: targetCards, updatedAt: serverTimestamp() });
        }

        const patch = {
            topCard: card,
            activeColor: wild ? selectedColor : card.color,
            discardPile,
            drawPile,
            handCounts,
            ...nextTurn(state, next, direction),
            unoPendingUid: remainingHand.length === 1 ? uid : null,
            unoCalled: false,
            forfeitedBy: null,
            updatedAt: serverTimestamp()
        };

        if (winning) {
            patch.status = "results";
            patch.winnerId = uid;
            patch.currentPlayerIndex = state.currentPlayerIndex;
            patch.currentPlayerUid = uid;
            patch.direction = state.direction;
            patch.drewCardId = null;
            patch.unoPendingUid = null;
            patch.unoCalled = false;
            patch.finishedAt = serverTimestamp();
        }

        tx.update(gRef, patch);
        return { winner: winning, card };
    });
}

export async function drawOneCard(db, roomId, round, uid) {
    return runTransaction(db, async (tx) => {
        const gRef = matchRef(db, roomId, round);
        const hRef = handRef(db, roomId, round, uid);
        const [gSnap, hSnap] = await Promise.all([tx.get(gRef), tx.get(hRef)]);
        if (!gSnap.exists() || !hSnap.exists()) throw new Error("Maç veya oyuncu eli bulunamadı.");

        const state = gSnap.data();
        requireTurn(state, uid);
        if (state.drewCardId) throw new Error("Bu turda zaten kart çektin.");

        const hand = Array.isArray(hSnap.data().cards) ? hSnap.data().cards : [];
        const draw = takeCards(state, 1);
        const card = draw.cards[0];

        if (!card) {
            const next = nextIndex(state, state.currentPlayerIndex, state.direction, 1);
            tx.update(gRef, {
                drawPile: draw.drawPile,
                discardPile: draw.discardPile,
                ...nextTurn(state, next, state.direction),
                ...clearUno(state),
                updatedAt: serverTimestamp()
            });
            return { card: null, playable: false, empty: true };
        }

        const playable = isCardPlayable(card, state.topCard, state.activeColor, hand);
        const nextHand = [...hand, card];
        tx.update(hRef, { cards: nextHand, updatedAt: serverTimestamp() });
        const handCounts = { ...(state.handCounts || {}), [uid]: nextHand.length };
        const next = playable
            ? state.currentPlayerIndex
            : nextIndex(state, state.currentPlayerIndex, state.direction, 1);

        tx.update(gRef, {
            drawPile: draw.drawPile,
            discardPile: draw.discardPile,
            handCounts,
            ...nextTurn(state, next, state.direction, { drewCardId: playable ? card.id : null }),
            unoPendingUid: null,
            unoCalled: false,
            updatedAt: serverTimestamp()
        });
        return { card, playable, empty: false };
    });
}

export async function endTurnAfterDraw(db, roomId, round, uid) {
    return runTransaction(db, async (tx) => {
        const ref = matchRef(db, roomId, round);
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("Maç bulunamadı.");
        const state = snap.data();
        requireTurn(state, uid);
        if (!state.drewCardId) throw new Error("Önce kart çekmelisin.");

        const next = nextIndex(state, state.currentPlayerIndex, state.direction, 1);
        tx.update(ref, {
            ...nextTurn(state, next, state.direction),
            ...clearUno(state),
            updatedAt: serverTimestamp()
        });
    });
}

export async function callUno(db, roomId, round, uid) {
    return runTransaction(db, async (tx) => {
        const ref = matchRef(db, roomId, round);
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("Maç bulunamadı.");
        const state = snap.data();
        requireActive(state, uid);
        if (state.unoPendingUid !== uid || state.unoCalled) {
            throw new Error("Şu anda UNO çağrısı yapamazsın.");
        }
        tx.update(ref, { unoCalled: true, updatedAt: serverTimestamp() });
    });
}

export async function catchUno(db, roomId, round, uid) {
    return runTransaction(db, async (tx) => {
        const gRef = matchRef(db, roomId, round);
        const gSnap = await tx.get(gRef);
        if (!gSnap.exists()) throw new Error("Maç bulunamadı.");
        const state = gSnap.data();
        requireActive(state, uid);

        if (!state.unoPendingUid || state.unoCalled || state.unoPendingUid === uid) {
            throw new Error("Yakalanabilecek bir UNO çağrısı yok.");
        }

        const targetUid = state.unoPendingUid;
        const hRef = handRef(db, roomId, round, targetUid);
        const hSnap = await tx.get(hRef);
        if (!hSnap.exists()) throw new Error("UNO çağrısı yapan oyuncunun eli bulunamadı.");

        const hand = Array.isArray(hSnap.data().cards) ? hSnap.data().cards : [];
        const draw = takeCards(state, 2);
        tx.update(hRef, {
            cards: [...hand, ...draw.cards],
            updatedAt: serverTimestamp()
        });
        tx.update(gRef, {
            drawPile: draw.drawPile,
            discardPile: draw.discardPile,
            handCounts: { ...(state.handCounts || {}), [targetUid]: hand.length + draw.cards.length },
            unoPendingUid: null,
            unoCalled: false,
            updatedAt: serverTimestamp()
        });
        return { targetUid, count: draw.cards.length };
    });
}

/**
 * Quit is one transaction and two authoritative reads. No preflight getDoc,
 * no hand read, and no separate roster-reconciliation transaction.
 */
export async function forfeitMatch(db, roomId, round, uid) {
    return runTransaction(db, async (tx) => {
        const sRef = sessionRef(db, roomId);
        const gRef = matchRef(db, roomId, round);
        const [sSnap, gSnap] = await Promise.all([tx.get(sRef), tx.get(gRef)]);
        if (!sSnap.exists()) throw new Error("Aktif UNO oyun lobisi bulunamadı.");

        const session = sSnap.data();
        if (
            session.gameId !== "uno" ||
            Number(session.round) !== Number(round) ||
            session.status !== "playing"
        ) {
            throw new Error("Bu UNO turu artık aktif değil.");
        }

        const lobby = ids(session.playerIds);
        const roster = matchPlayers(session);
        if (!lobby.includes(uid) || !roster.includes(uid)) {
            return { left: false, reason: "not-active" };
        }

        const nextLobby = lobby.filter((id) => id !== uid);
        const nextRoster = roster.filter((id) => id !== uid);
        if (!nextLobby.length) throw new Error("Lobide başka oyuncu kalmadı.");
        const nextHost = session.hostId === uid ? nextLobby[0] : session.hostId;

        if (!gSnap.exists()) {
            // No one dealt cards yet. Cancel this empty round rather than
            // creating a fake result document just to record a quit.
            tx.update(sRef, {
                status: "lobby",
                round: Number(session.round) + 1,
                hostId: nextHost,
                playerIds: nextLobby,
                readyIds: [],
                matchPlayerIds: [],
                spectatorIds: [],
                nextRoundPlayerIds: [],
                nextRoundReadyIds: [],
                resultReturnIds: [],
                startedAt: null,
                countdownEndsAt: null,
                finishedAt: null,
                updatedAt: serverTimestamp()
            });
            return { left: true, finished: false, cancelledBeforeDeal: true };
        }

        const state = gSnap.data();
        if (
            state.roomId !== roomId ||
            Number(state.round) !== Number(round) ||
            !["playing", "results"].includes(state.status)
        ) {
            throw new Error("Bu UNO turunun maç kaydı geçersiz.");
        }

        const active = ids(state.activePlayerIds);
        const isLegacyPartial =
            state.forfeitedBy === uid &&
            !active.includes(uid) &&
            state.status === "results" &&
            nextRoster.length === active.length &&
            nextRoster.every((id, index) => id === active[index]);

        if (isLegacyPartial) {
            tx.update(sRef, {
                status: "results",
                hostId: nextHost,
                playerIds: nextLobby,
                readyIds: [],
                matchPlayerIds: nextRoster,
                resultReturnIds: [],
                nextRoundPlayerIds: [],
                nextRoundReadyIds: [],
                finishedAt: state.finishedAt || serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            return {
                left: true,
                finished: true,
                winner: state.winnerId || nextRoster[0] || null,
                recovered: true
            };
        }

        if (state.status !== "playing" || !nextRoster.length) {
            throw new Error("Bu maçta artık ayrılabilecek aktif oyuncu değilsin.");
        }

        const previousOrder = active.length ? active : roster;
        const nextCurrent = nextRemaining(
            previousOrder,
            nextRoster,
            state.currentPlayerUid,
            state.direction,
            state.currentPlayerIndex
        );
        const winner = nextRoster.length === 1 ? nextRoster[0] : null;
        const currentChanged = nextCurrent !== state.currentPlayerUid;
        const changedAt = serverTimestamp();

        const gameUpdate = {
            activePlayerIds: nextRoster,
            currentPlayerIndex: nextRoster.indexOf(winner || nextCurrent),
            currentPlayerUid: winner || nextCurrent,
            drewCardId: null,
            forfeitedBy: uid,
            unoPendingUid: nextRoster.includes(state.unoPendingUid) ? state.unoPendingUid : null,
            unoCalled: nextRoster.includes(state.unoPendingUid) ? state.unoCalled : false,
            updatedAt: changedAt
        };

        const sessionUpdate = {
            status: winner ? "results" : "playing",
            hostId: nextHost,
            playerIds: nextLobby,
            // Ready state is cleared when a round starts; discard any stale values.
            readyIds: [],
            matchPlayerIds: nextRoster,
            resultReturnIds: [],
            finishedAt: winner ? changedAt : null,
            updatedAt: changedAt
        };

        if (winner) {
            gameUpdate.status = "results";
            gameUpdate.winnerId = winner;
            gameUpdate.unoPendingUid = null;
            gameUpdate.unoCalled = false;
            gameUpdate.finishedAt = changedAt;
            sessionUpdate.nextRoundPlayerIds = [];
            sessionUpdate.nextRoundReadyIds = [];
        } else {
            gameUpdate.status = "playing";
            gameUpdate.winnerId = null;
            if (currentChanged) {
                gameUpdate.turnNumber = (Number(state.turnNumber) || 0) + 1;
                gameUpdate.turnStartedAt = changedAt;
            }
        }

        tx.update(gRef, gameUpdate);
        tx.update(sRef, sessionUpdate);
        return { left: true, finished: Boolean(winner), winner };
    });
}

export async function returnToLobby(db, roomId, round, uid) {
    const sRef = sessionRef(db, roomId);
    const gRef = matchRef(db, roomId, round);

    const ack = await runTransaction(db, async (tx) => {
        const [sSnap, gSnap] = await Promise.all([tx.get(sRef), tx.get(gRef)]);
        if (!sSnap.exists() || !gSnap.exists()) throw new Error("UNO maç sonucu veya oyun lobisi bulunamadı.");

        const session = sSnap.data();
        const match = gSnap.data();
        if (
            session.gameId !== "uno" ||
            Number(session.round) !== Number(round) ||
            match.roomId !== roomId ||
            Number(match.round) !== Number(round) ||
            match.status !== "results"
        ) {
            throw new Error("Bu UNO maçının sonuçları artık güncel değil.");
        }

        const players = matchPlayers(session);
        if (!players.includes(uid)) throw new Error("Bu oyuncu sonuç ekranında aktif değil.");
        const returned = returnedPlayers(session);
        const cleanupPlayerIds = ids(match.playerIds);

        if (returned.includes(uid)) {
            return { players, returned, cleanupPlayerIds, alreadyReturned: true };
        }

        const nextReturned = [...returned, uid];
        if (session.status === "playing") {
            if (
                !match.winnerId ||
                !players.includes(match.winnerId) ||
                !players.every((id) => match.activePlayerIds?.includes(id))
            ) {
                throw new Error("UNO kazananı veya aktif oyuncu listesi doğrulanamadı.");
            }
            tx.update(sRef, {
                status: "results",
                resultReturnIds: [uid],
                finishedAt: match.finishedAt || serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        } else if (session.status === "results") {
            tx.update(sRef, {
                resultReturnIds: arrayUnion(uid),
                updatedAt: serverTimestamp()
            });
        } else {
            throw new Error("Oyun oturumu sonuç ekranında değil.");
        }

        return { players, returned: nextReturned, cleanupPlayerIds, alreadyReturned: false };
    });

    const allReturned = ack.players.length > 0 && ack.players.every((id) => ack.returned.includes(id));
    if (!allReturned) {
        return {
            completed: false,
            alreadyReturned: ack.alreadyReturned,
            returnedCount: ack.returned.length,
            requiredCount: ack.players.length,
            waitingFor: ack.players.filter((id) => !ack.returned.includes(id))
        };
    }

    const completion = await runTransaction(db, async (tx) => {
        const snap = await tx.get(sRef);
        if (!snap.exists()) throw new Error("Oyun lobisi bulunamadı.");
        const session = snap.data();

        if (
            session.gameId !== "uno" ||
            session.status !== "results" ||
            Number(session.round) !== Number(round)
        ) {
            if (
                session.gameId === "uno" &&
                session.status === "lobby" &&
                Number(session.round) === Number(round) + 1
            ) {
                return { completed: true, alreadyCompleted: true };
            }
            throw new Error("UNO sonuç onayları değişti. Lobi geçişi yeniden denenmeli.");
        }

        const players = matchPlayers(session);
        const returned = returnedPlayers(session);
        if (!players.length || !players.every((id) => returned.includes(id))) {
            return { completed: false };
        }

        const nextPlayers = ids([
            ...ids(session.playerIds),
            ...ids(session.spectatorIds),
            ...ids(session.nextRoundPlayerIds)
        ]);
        if (nextPlayers.length > MAX_PLAYERS) throw new Error("Sonraki UNO lobisi oyuncu sınırını aşıyor.");

        tx.update(sRef, {
            status: "lobby",
            round: Number(session.round) + 1,
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
            updatedAt: serverTimestamp()
        });
        return { completed: true, alreadyCompleted: false };
    });

    if (!completion.completed) {
        return {
            completed: false,
            returnedCount: ack.returned.length,
            requiredCount: ack.players.length,
            waitingFor: ack.players.filter((id) => !ack.returned.includes(id))
        };
    }

    if (!completion.alreadyCompleted) {
        try {
            const cleanup = ack.cleanupPlayerIds.length ? ack.cleanupPlayerIds : ack.players;
            for (let index = 0; index < cleanup.length; index += 400) {
                const batch = writeBatch(db);
                cleanup.slice(index, index + 400).forEach((playerId) => {
                    batch.delete(handRef(db, roomId, round, playerId));
                });
                await batch.commit();
            }
            await deleteDoc(gRef);
        } catch (error) {
            console.warn("CACA UNO old round cleanup failed:", error);
        }
    }

    return {
        completed: true,
        alreadyCompleted: Boolean(completion.alreadyCompleted),
        round: Number(round) + 1,
        returnedCount: ack.players.length,
        requiredCount: ack.players.length
    };
}

/** Only the first active player coordinates a stalled turn. */
export async function skipTimedOutTurn(db, roomId, round, uid, timeoutMs = DEFAULT_TIMEOUT) {
    return runTransaction(db, async (tx) => {
        const ref = matchRef(db, roomId, round);
        const snap = await tx.get(ref);
        if (!snap.exists()) return false;
        const state = snap.data();
        requireActive(state, uid);
        if (state.activePlayerIds[0] !== uid) return false;

        const startedAt = state.turnStartedAt?.toMillis?.();
        if (!Number.isFinite(startedAt) || Date.now() - startedAt < timeoutMs) return false;

        const next = nextIndex(state, state.currentPlayerIndex, state.direction, 1);
        tx.update(ref, {
            ...nextTurn(state, next, state.direction),
            ...clearUno(state),
            updatedAt: serverTimestamp()
        });
        return true;
    });
}

export async function reconcileMatchPlayers(db, roomId, round, uid) {
    return runTransaction(db, async (tx) => {
        const sRef = sessionRef(db, roomId);
        const gRef = matchRef(db, roomId, round);
        const [sSnap, gSnap] = await Promise.all([tx.get(sRef), tx.get(gRef)]);
        if (!sSnap.exists() || !gSnap.exists()) return false;

        const session = sSnap.data();
        const state = gSnap.data();
        if (
            session.gameId !== "uno" ||
            session.status !== "playing" ||
            Number(session.round) !== Number(round) ||
            state.status !== "playing"
        ) return false;

        const allowed = matchPlayers(session);
        if (!allowed.includes(uid) || !allowed.length) return false;

        const previous = ids(state.activePlayerIds);
        if (allowed.length === previous.length && allowed.every((id, i) => id === previous[i])) {
            return false;
        }

        const nextCurrent = nextRemaining(
            previous.length ? previous : allowed,
            allowed,
            state.currentPlayerUid,
            state.direction,
            state.currentPlayerIndex
        );
        const finished = allowed.length === 1;
        const changedAt = serverTimestamp();
        const patch = {
            activePlayerIds: allowed,
            currentPlayerIndex: allowed.indexOf(finished ? allowed[0] : nextCurrent),
            currentPlayerUid: finished ? allowed[0] : nextCurrent,
            drewCardId: null,
            unoPendingUid: allowed.includes(state.unoPendingUid) ? state.unoPendingUid : null,
            unoCalled: allowed.includes(state.unoPendingUid) ? state.unoCalled : false,
            updatedAt: changedAt
        };

        if (finished) {
            patch.status = "results";
            patch.winnerId = allowed[0];
            patch.unoPendingUid = null;
            patch.unoCalled = false;
            patch.finishedAt = changedAt;
        } else if (nextCurrent !== state.currentPlayerUid) {
            patch.turnNumber = (Number(state.turnNumber) || 0) + 1;
            patch.turnStartedAt = changedAt;
        }

        tx.update(gRef, patch);
        return true;
    });
}

export function subscribeToMatch(db, roomId, round, uid, onState, onHand, onError, watchHand = true) {
    const unsubscribers = [
        onSnapshot(
            matchRef(db, roomId, round),
            (snap) => onState(snap.exists() ? snap.data() : null),
            (error) => onError?.(error, "Maç verisi")
        )
    ];

    if (watchHand) {
        unsubscribers.push(onSnapshot(
            handRef(db, roomId, round, uid),
            (snap) => onHand(snap.exists() ? snap.data() : null),
            (error) => onError?.(error, "Kartların")
        ));
    }

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}
