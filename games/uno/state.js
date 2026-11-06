import {
    doc,
    onSnapshot,
    runTransaction,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

import { createUnoDeck, shuffleDeck } from "./deck.js";
import {
    UNO_COLORS,
    getPlayEffect,
    isCardPlayable,
    nextPlayerIndex
} from "./engine.js";

function sessionRef(db, roomId) {
    return doc(db, "rooms", roomId, "gameSessions", "active");
}

function matchRef(db, roomId, round) {
    return doc(db, "rooms", roomId, "unoMatches", String(round));
}

function handRef(db, roomId, round, uid) {
    return doc(db, "rooms", roomId, "unoMatches", String(round), "hands", uid);
}


function requirePlayingMatch(state, uid) {
    if (!state || state.status !== "playing") {
        throw new Error("Bu UNO maçı artık devam etmiyor.");
    }

    if (!Array.isArray(state.activePlayerIds) || !state.activePlayerIds.includes(uid)) {
        throw new Error("Bu maçın aktif oyuncusu değilsin.");
    }
}

function requireTurn(state, uid) {
    requirePlayingMatch(state, uid);

    if (state.currentPlayerUid !== uid) {
        throw new Error("Sıra sende değil.");
    }
}

function nextIndex(state, index, direction, steps = 1) {
    return nextPlayerIndex(index, direction, state.activePlayerIds.length, steps);
}

function buildInitialState(roomId, round, playerIds, dealerId, deck) {
    const handCounts = {};
    playerIds.forEach((uid) => { handCounts[uid] = 7; });

    const dealCount = playerIds.length * 7;
    const topCard = deck[dealCount];

    return {
        roomId,
        round,
        status: "playing",
        playerIds: [...playerIds],
        activePlayerIds: [...playerIds],
        dealerId,
        direction: 1,
        currentPlayerIndex: 0,
        currentPlayerUid: playerIds[0],
        activeColor: topCard.color,
        topCard,
        discardPile: [topCard],
        drawPile: deck.slice(dealCount + 1),
        handCounts,
        drewCardId: null,
        drewCardPlayable: false,
        unoPendingUid: null,
        unoCalled: false,
        winnerId: null,
        turnNumber: 1,
        lastActionType: "start",
        lastActionBy: dealerId,
        lastActionTargetUid: null,
        lastActionDrawnCards: [],
        lastPlayedCard: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        turnStartedAt: serverTimestamp()
    };
}

export async function ensureMatch(db, roomId, round, uid) {
    return runTransaction(db, async (transaction) => {
        const activeRef = sessionRef(db, roomId);
        const gameRef = matchRef(db, roomId, round);
        const activeSnapshot = await transaction.get(activeRef);
        const matchSnapshot = await transaction.get(gameRef);

        if (!activeSnapshot.exists()) {
            throw new Error("Kalıcı oyun lobisi bulunamadı.");
        }

        const session = activeSnapshot.data();
        const playerIds = Array.isArray(session.matchPlayerIds) ? session.matchPlayerIds : [];

        if (session.status !== "playing" || session.gameId !== "uno" || Number(session.round) !== Number(round)) {
            throw new Error("UNO maçı başlatılmaya hazır değil.");
        }

        if (playerIds.length < 2 || playerIds.length > 10 || !playerIds.includes(uid)) {
            throw new Error("UNO maçına yalnızca sabitlenmiş maç oyuncuları katılabilir.");
        }

        if (matchSnapshot.exists()) {
            return matchSnapshot.data();
        }

        const deck = shuffleDeck(createUnoDeck());
        const dealCount = playerIds.length * 7;
        const openingNumberIndex = deck.findIndex((card, index) =>
            index >= dealCount && card.type === "number"
        );

        if (openingNumberIndex < 0) {
            throw new Error("Açılış kartı oluşturulamadı.");
        }

        [deck[dealCount], deck[openingNumberIndex]] = [deck[openingNumberIndex], deck[dealCount]];

        const state = buildInitialState(roomId, round, playerIds, uid, deck);

        transaction.set(gameRef, state);

        playerIds.forEach((playerId, playerIndex) => {
            const cards = deck.slice(playerIndex * 7, playerIndex * 7 + 7);
            transaction.set(handRef(db, roomId, round, playerId), {
                cards,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        });


        return state;
    });
}

function collectDrawCards(state, count, discardPile) {
    let drawPile = [...(state.drawPile || [])];
    let nextDiscard = [...discardPile];

    if (drawPile.length < count) {
        const topCard = nextDiscard[nextDiscard.length - 1];
        drawPile = drawPile.concat(shuffleDeck(nextDiscard.slice(0, -1)));
        nextDiscard = topCard ? [topCard] : [];
    }

    const cards = drawPile.splice(0, count);
    return {
        cards,
        drawPile,
        discardPile: nextDiscard
    };
}

function clearExpiredUno(state) {
    if (!state.unoPendingUid) return {};
    return { unoPendingUid: null, unoCalled: false };
}

function createNextTurnPatch(state, index, direction, extra = {}) {
    const nextPlayerIndexValue = nextIndex(state, index, direction, 0);
    return {
        currentPlayerIndex: nextPlayerIndexValue,
        currentPlayerUid: state.activePlayerIds[nextPlayerIndexValue],
        direction,
        drewCardId: null,
        drewCardPlayable: false,
        turnNumber: (Number(state.turnNumber) || 0) + 1,
        turnStartedAt: serverTimestamp(),
        ...extra
    };
}

function makeResultSessionPatch(session) {
    const players = Array.isArray(session.playerIds) ? session.playerIds : [];
    const spectators = Array.isArray(session.spectatorIds) ? session.spectatorIds : [];
    const persistentPlayers = [...new Set([...players, ...spectators])];

    return {
        status: "results",
        playerIds: persistentPlayers,
        readyIds: [],
        matchPlayerIds: Array.isArray(session.matchPlayerIds) ? session.matchPlayerIds : [],
        spectatorIds: [],
        nextRoundPlayerIds: [],
        nextRoundReadyIds: [],
        finishedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    };
}

export async function playCard(db, roomId, round, uid, cardId, selectedColor = null) {
    return runTransaction(db, async (transaction) => {
        const gameDocument = matchRef(db, roomId, round);
        const playerHandDocument = handRef(db, roomId, round, uid);
        const gameSnapshot = await transaction.get(gameDocument);
        const handSnapshot = await transaction.get(playerHandDocument);
        const activeSnapshot = await transaction.get(sessionRef(db, roomId));

        if (!gameSnapshot.exists() || !handSnapshot.exists()) {
            throw new Error("Maç veya oyuncu eli bulunamadı.");
        }

        const state = gameSnapshot.data();
        requireTurn(state, uid);

        const hand = Array.isArray(handSnapshot.data().cards) ? handSnapshot.data().cards : [];
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

        const isWild = card.type === "wild" || card.type === "wild4";
        if (isWild && !UNO_COLORS.includes(selectedColor)) {
            throw new Error("Renk değiştirme kartı için bir renk seçmelisin.");
        }
        if (!isWild && selectedColor !== null) {
            throw new Error("Normal kartlarda renk seçilemez.");
        }

        const remainingHand = hand.filter((item) => item.id !== card.id);
        const playerIds = state.activePlayerIds;
        const currentIndex = state.currentPlayerIndex;
        const effect = getPlayEffect(card, playerIds.length, state.direction);
        const nextDirection = effect.direction;
        const discardAfterPlay = [...(state.discardPile || [state.topCard]), card];
        let drawPile = [...(state.drawPile || [])];
        let discardPile = discardAfterPlay;
        let handCounts = { ...state.handCounts, [uid]: remainingHand.length };
        let nextTurnIndex = nextIndex(state, currentIndex, nextDirection, effect.steps);
        let targetUid = null;
        let drawnCards = [];
        let targetHandDocument = null;
        let targetHand = [];

        if (effect.drawCount > 0) {
            const targetIndex = nextIndex(state, currentIndex, state.direction, effect.targetIndexOffset);
            targetUid = playerIds[targetIndex];
            targetHandDocument = handRef(db, roomId, round, targetUid);
            const targetHandSnapshot = await transaction.get(targetHandDocument);
            if (!targetHandSnapshot.exists()) {
                throw new Error("Ceza kartı alacak oyuncunun eli bulunamadı.");
            }
            targetHand = Array.isArray(targetHandSnapshot.data().cards)
                ? targetHandSnapshot.data().cards
                : [];

            const drawResult = collectDrawCards(state, effect.drawCount, discardAfterPlay);
            drawnCards = drawResult.cards;
            drawPile = drawResult.drawPile;
            discardPile = drawResult.discardPile;
            handCounts[targetUid] = targetHand.length + drawnCards.length;
            nextTurnIndex = nextIndex(state, targetIndex, state.direction, 1);
        }

        if (targetHandDocument && drawnCards.length) {
            transaction.update(targetHandDocument, {
                cards: [...targetHand, ...drawnCards],
                updatedAt: serverTimestamp()
            });
        }

        transaction.update(playerHandDocument, {
            cards: remainingHand,
            updatedAt: serverTimestamp()
        });

        const patch = {
            topCard: card,
            activeColor: selectedColor || card.color,
            discardPile,
            drawPile,
            handCounts,
            ...createNextTurnPatch(state, nextTurnIndex, nextDirection),
            unoPendingUid: remainingHand.length === 1 ? uid : null,
            unoCalled: false,
            lastActionType: effect.drawCount === 2 ? "draw2" : effect.drawCount === 4 ? "wild4" : "play",
            lastActionBy: uid,
            lastActionTargetUid: targetUid,
            lastActionDrawnCards: drawnCards,
            lastPlayedCard: card,
            updatedAt: serverTimestamp()
        };

        if (remainingHand.length === 0) {
            const activeRef = sessionRef(db, roomId);
            if (!activeSnapshot.exists() || activeSnapshot.data().status !== "playing") {
                throw new Error("Kalıcı lobi maç bitişine hazır değil.");
            }

            patch.status = "results";
            patch.winnerId = uid;
            patch.unoPendingUid = null;
            patch.unoCalled = false;
            patch.finishedAt = serverTimestamp();

            transaction.update(activeRef, makeResultSessionPatch(activeSnapshot.data()));
        }

        transaction.update(gameDocument, patch);
        return { winner: remainingHand.length === 0, card };
    });
}

export async function drawOneCard(db, roomId, round, uid) {
    return runTransaction(db, async (transaction) => {
        const gameDocument = matchRef(db, roomId, round);
        const playerHandDocument = handRef(db, roomId, round, uid);
        const gameSnapshot = await transaction.get(gameDocument);
        const handSnapshot = await transaction.get(playerHandDocument);

        if (!gameSnapshot.exists() || !handSnapshot.exists()) {
            throw new Error("Maç veya oyuncu eli bulunamadı.");
        }

        const state = gameSnapshot.data();
        requireTurn(state, uid);
        if (state.drewCardId) throw new Error("Bu turda zaten kart çektin.");

        const hand = Array.isArray(handSnapshot.data().cards) ? handSnapshot.data().cards : [];
        const result = collectDrawCards(
            state,
            1,
            state.discardPile || [state.topCard]
        );
        const card = result.cards[0];

        if (!card) {
            const next = nextIndex(state, state.currentPlayerIndex, state.direction, 1);
            transaction.update(gameDocument, {
                drawPile: result.drawPile,
                discardPile: result.discardPile,
                ...createNextTurnPatch(state, next, state.direction),
                ...clearExpiredUno(state),
                lastActionType: "pass",
                lastActionBy: uid,
                lastActionTargetUid: null,
                lastActionDrawnCards: [],
                lastPlayedCard: null,
                updatedAt: serverTimestamp()
            });
            return { card: null, playable: false, empty: true };
        }

        const canPlay = isCardPlayable(card, state.topCard, state.activeColor, hand);
        const handAfter = [...hand, card];
        const handCounts = { ...state.handCounts, [uid]: handAfter.length };

        transaction.update(playerHandDocument, {
            cards: handAfter,
            updatedAt: serverTimestamp()
        });

        const nextIndexValue = canPlay
            ? state.currentPlayerIndex
            : nextIndex(state, state.currentPlayerIndex, state.direction, 1);

        transaction.update(gameDocument, {
            drawPile: result.drawPile,
            discardPile: result.discardPile,
            handCounts,
            ...createNextTurnPatch(state, nextIndexValue, state.direction, {
                drewCardId: canPlay ? card.id : null,
                drewCardPlayable: canPlay
            }),
            unoPendingUid: null,
            unoCalled: false,
            lastActionType: "draw",
            lastActionBy: uid,
            lastActionTargetUid: null,
            lastActionDrawnCards: [card],
            lastPlayedCard: null,
            updatedAt: serverTimestamp()
        });

        return { card, playable: canPlay, empty: false };
    });
}

export async function endTurnAfterDraw(db, roomId, round, uid) {
    return runTransaction(db, async (transaction) => {
        const gameDocument = matchRef(db, roomId, round);
        const gameSnapshot = await transaction.get(gameDocument);
        if (!gameSnapshot.exists()) throw new Error("Maç bulunamadı.");

        const state = gameSnapshot.data();
        requireTurn(state, uid);
        if (!state.drewCardId) throw new Error("Önce kart çekmelisin.");

        const next = nextIndex(state, state.currentPlayerIndex, state.direction, 1);
        transaction.update(gameDocument, {
            ...createNextTurnPatch(state, next, state.direction),
            ...clearExpiredUno(state),
            lastActionType: "pass",
            lastActionBy: uid,
            lastActionTargetUid: null,
            lastActionDrawnCards: [],
            lastPlayedCard: null,
            updatedAt: serverTimestamp()
        });
    });
}

export async function callUno(db, roomId, round, uid) {
    return runTransaction(db, async (transaction) => {
        const gameDocument = matchRef(db, roomId, round);
        const snapshot = await transaction.get(gameDocument);
        if (!snapshot.exists()) throw new Error("Maç bulunamadı.");

        const state = snapshot.data();
        requirePlayingMatch(state, uid);

        if (state.unoPendingUid !== uid || state.unoCalled) {
            throw new Error("Şu anda UNO çağrısı yapamazsın.");
        }

        transaction.update(gameDocument, {
            unoCalled: true,
            lastActionType: "callUno",
            lastActionBy: uid,
            lastActionTargetUid: null,
            lastActionDrawnCards: [],
            updatedAt: serverTimestamp()
        });
    });
}

export async function catchUno(db, roomId, round, uid) {
    return runTransaction(db, async (transaction) => {
        const gameDocument = matchRef(db, roomId, round);
        const snapshot = await transaction.get(gameDocument);
        if (!snapshot.exists()) throw new Error("Maç bulunamadı.");

        const state = snapshot.data();
        requirePlayingMatch(state, uid);

        if (!state.unoPendingUid || state.unoCalled || state.unoPendingUid === uid) {
            throw new Error("Yakalanabilecek bir UNO çağrısı yok.");
        }

        const targetUid = state.unoPendingUid;
        const targetHandDocument = handRef(db, roomId, round, targetUid);
        const targetHandSnapshot = await transaction.get(targetHandDocument);
        if (!targetHandSnapshot.exists()) {
            throw new Error("UNO cezası alacak oyuncunun eli bulunamadı.");
        }
        const targetHand = Array.isArray(targetHandSnapshot.data().cards)
            ? targetHandSnapshot.data().cards
            : [];

        const result = collectDrawCards(
            state,
            2,
            state.discardPile || [state.topCard]
        );

        if (result.cards.length) {
            transaction.update(targetHandDocument, {
                cards: [...targetHand, ...result.cards],
                updatedAt: serverTimestamp()
            });
        }

        const handCounts = {
            ...state.handCounts,
            [targetUid]: targetHand.length + result.cards.length
        };

        transaction.update(gameDocument, {
            drawPile: result.drawPile,
            discardPile: result.discardPile,
            handCounts,
            unoPendingUid: null,
            unoCalled: false,
            lastActionType: "catchUno",
            lastActionBy: uid,
            lastActionTargetUid: targetUid,
            lastActionDrawnCards: result.cards,
            lastPlayedCard: null,
            updatedAt: serverTimestamp()
        });

        return { targetUid, count: result.cards.length };
    });
}

export function reconcileMatchPlayers(db, roomId, round, uid) {
    return runTransaction(db, async (transaction) => {
        const activeDocument = sessionRef(db, roomId);
        const gameDocument = matchRef(db, roomId, round);
        const activeSnapshot = await transaction.get(activeDocument);
        const gameSnapshot = await transaction.get(gameDocument);
        if (!activeSnapshot.exists() || !gameSnapshot.exists()) return false;

        const session = activeSnapshot.data();
        const state = gameSnapshot.data();
        if (session.status !== "playing" || state.status !== "playing") return false;

        const lobbyMatchPlayers = Array.isArray(session.matchPlayerIds) ? session.matchPlayerIds : [];
        if (!lobbyMatchPlayers.includes(uid)) return false;

        const previousPlayers = Array.isArray(state.activePlayerIds)
            ? state.activePlayerIds
            : state.playerIds;
        const remainingPlayers = state.playerIds.filter((playerId) =>
            lobbyMatchPlayers.includes(playerId)
        );

        if (
            previousPlayers.length === remainingPlayers.length &&
            previousPlayers.every((playerId, index) => playerId === remainingPlayers[index])
        ) {
            return false;
        }

        if (remainingPlayers.length === 0) return false;

        if (remainingPlayers.length === 1) {
            const winnerId = remainingPlayers[0];
            transaction.update(gameDocument, {
                activePlayerIds: remainingPlayers,
                currentPlayerIndex: 0,
                currentPlayerUid: winnerId,
                drewCardId: null,
                drewCardPlayable: false,
                status: "results",
                winnerId,
                unoPendingUid: null,
                unoCalled: false,
                finishedAt: serverTimestamp(),
                lastActionType: "player-left",
                lastActionBy: uid,
                updatedAt: serverTimestamp()
            });
            transaction.update(activeDocument, makeResultSessionPatch(session));
            return true;
        }

        let nextUid = state.currentPlayerUid;
        if (!remainingPlayers.includes(nextUid)) {
            const oldIndex = Math.max(0, previousPlayers.indexOf(state.currentPlayerUid));
            nextUid = remainingPlayers[0];

            for (let step = 1; step <= previousPlayers.length; step += 1) {
                const candidateIndex = (
                    oldIndex + (state.direction === -1 ? -step : step) + previousPlayers.length * 2
                ) % previousPlayers.length;
                const candidate = previousPlayers[candidateIndex];
                if (remainingPlayers.includes(candidate)) {
                    nextUid = candidate;
                    break;
                }
            }
        }

        const currentPlayerChanged = nextUid !== state.currentPlayerUid;
        transaction.update(gameDocument, {
            activePlayerIds: remainingPlayers,
            currentPlayerIndex: remainingPlayers.indexOf(nextUid),
            currentPlayerUid: nextUid,
            drewCardId: currentPlayerChanged ? null : state.drewCardId,
            drewCardPlayable: currentPlayerChanged ? false : state.drewCardPlayable,
            unoPendingUid: remainingPlayers.includes(state.unoPendingUid) ? state.unoPendingUid : null,
            unoCalled: remainingPlayers.includes(state.unoPendingUid) ? state.unoCalled : false,
            lastActionType: "player-left",
            lastActionBy: uid,
            updatedAt: serverTimestamp(),
            turnStartedAt: currentPlayerChanged ? serverTimestamp() : state.turnStartedAt
        });
        return true;
    });
}

export function skipTimedOutTurn(db, roomId, round, uid, timeoutMs = 90000) {
    return runTransaction(db, async (transaction) => {
        const gameDocument = matchRef(db, roomId, round);
        const activeDocument = sessionRef(db, roomId);
        const gameSnapshot = await transaction.get(gameDocument);
        const activeSnapshot = await transaction.get(activeDocument);
        if (!gameSnapshot.exists() || !activeSnapshot.exists()) return false;

        const state = gameSnapshot.data();
        const session = activeSnapshot.data();
        requirePlayingMatch(state, uid);
        if (session.status !== "playing" || !session.matchPlayerIds?.includes(uid)) return false;

        const startedAt = state.turnStartedAt?.toMillis?.();
        if (!Number.isFinite(startedAt) || Date.now() - startedAt < timeoutMs) return false;

        const next = nextIndex(state, state.currentPlayerIndex, state.direction, 1);
        transaction.update(gameDocument, {
            ...createNextTurnPatch(state, next, state.direction),
            ...clearExpiredUno(state),
            lastActionType: "timeout",
            lastActionBy: uid,
            lastActionTargetUid: null,
            lastActionDrawnCards: [],
            lastPlayedCard: null,
            updatedAt: serverTimestamp()
        });
        return true;
    });
}

export function subscribeToMatch(db, roomId, round, uid, onState, onHand, onError, watchHand = true) {
    const unsubscribers = [
        onSnapshot(matchRef(db, roomId, round), (snapshot) => {
            onState(snapshot.exists() ? snapshot.data() : null);
        }, onError)
    ];

    if (watchHand) {
        unsubscribers.push(onSnapshot(handRef(db, roomId, round, uid), (snapshot) => {
            onHand(snapshot.exists() ? snapshot.data() : null);
        }, onError));
    }

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}
