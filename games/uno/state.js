import {
    arrayUnion,
    doc,
    onSnapshot,
    runTransaction,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

import { createDocumentId, createUnoDeck, shuffleDeck } from "./deck.js";
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

function drawCardRef(db, roomId, round, cardDocumentId) {
    return doc(db, "rooms", roomId, "unoMatches", String(round), "drawCards", cardDocumentId);
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

function buildInitialState(roomId, round, playerIds, dealerId, deck, drawOrder) {
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
        drawOrder,
        drawIndex: dealCount + 1,
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
        deckRecycledBy: null,
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

        if (matchSnapshot.exists()) {
            return matchSnapshot.data();
        }

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

        const deck = shuffleDeck(createUnoDeck());
        const dealCount = playerIds.length * 7;
        const openingNumberIndex = deck.findIndex((card, index) =>
            index >= dealCount && card.type === "number"
        );

        if (openingNumberIndex < 0) {
            throw new Error("Açılış kartı oluşturulamadı.");
        }

        [deck[dealCount], deck[openingNumberIndex]] = [deck[openingNumberIndex], deck[dealCount]];

        const drawOrder = deck.map(() => createDocumentId());
        const state = buildInitialState(roomId, round, playerIds, uid, deck, drawOrder);

        transaction.set(gameRef, state);

        playerIds.forEach((playerId, playerIndex) => {
            const cards = deck.slice(playerIndex * 7, playerIndex * 7 + 7);
            transaction.set(handRef(db, roomId, round, playerId), {
                cards,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        });

        deck.forEach((card, index) => {
            transaction.set(drawCardRef(db, roomId, round, drawOrder[index]), {
                card,
                createdAt: serverTimestamp()
            });
        });

        return state;
    });
}

async function collectDrawCards(transaction, db, roomId, round, state, count, discardPile, uid) {
    const drawOrder = [...state.drawOrder];
    const remaining = Math.max(0, drawOrder.length - state.drawIndex);
    const cards = [];

    const fromCurrentDeck = Math.min(remaining, count);
    for (let offset = 0; offset < fromCurrentDeck; offset += 1) {
        const documentId = drawOrder[state.drawIndex + offset];
        const snapshot = await transaction.get(drawCardRef(db, roomId, round, documentId));
        if (!snapshot.exists() || !snapshot.data()?.card) {
            throw new Error("Çekme destesindeki kart bulunamadı. Maç durumu tutarsız.");
        }
        cards.push(snapshot.data().card);
    }

    let nextOrder = drawOrder;
    let nextIndex = state.drawIndex + fromCurrentDeck;
    let nextDiscard = [...discardPile];
    let recycled = false;

    if (cards.length < count) {
        const topCard = discardPile[discardPile.length - 1];
        const recyclable = shuffleDeck(discardPile.slice(0, -1));

        const needed = count - cards.length;
        const recycledCount = Math.min(recyclable.length, needed);
        cards.push(...recyclable.slice(0, recycledCount));

        // Cards handed to the player directly are not also written into the draw pile.
        const remainingRecycled = recyclable.slice(recycledCount);
        const newIds = remainingRecycled.map(() => createDocumentId());
        remainingRecycled.forEach((card, index) => {
            transaction.set(drawCardRef(db, roomId, round, newIds[index]), {
                card,
                createdAt: serverTimestamp()
            });
        });

        nextOrder = drawOrder.slice(0, state.drawIndex + fromCurrentDeck).concat(newIds);
        nextDiscard = [topCard];
        recycled = remainingRecycled.length > 0;
    }

    return {
        cards,
        drawOrder: nextOrder,
        drawIndex: nextIndex,
        discardPile: nextDiscard,
        deckRecycledBy: recycled ? uid : null
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

        if (state.unoPendingUid && !state.unoCalled && state.unoPendingUid !== uid) {
            throw new Error("Önce UNO demeyen oyuncuyu yakalayın veya oyuncunun UNO demesini bekleyin.");
        }

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
        let drawOrder = state.drawOrder;
        let drawIndex = state.drawIndex;
        let discardPile = discardAfterPlay;
        let deckRecycledBy = null;
        let handCounts = { ...state.handCounts, [uid]: remainingHand.length };
        let nextTurnIndex = nextIndex(state, currentIndex, nextDirection, effect.steps);
        let targetUid = null;
        let drawnCards = [];

        if (effect.drawCount > 0) {
            const targetIndex = nextIndex(state, currentIndex, state.direction, effect.targetIndexOffset);
            targetUid = playerIds[targetIndex];

            const drawResult = await collectDrawCards(
                transaction,
                db,
                roomId,
                round,
                { ...state, direction: state.direction },
                effect.drawCount,
                discardAfterPlay,
                uid
            );

            drawnCards = drawResult.cards;
            drawOrder = drawResult.drawOrder;
            drawIndex = drawResult.drawIndex;
            discardPile = drawResult.discardPile;
            deckRecycledBy = drawResult.deckRecycledBy;
            handCounts[targetUid] = (Number(handCounts[targetUid]) || 0) + drawnCards.length;
            nextTurnIndex = nextIndex(state, targetIndex, state.direction, 1);

            if (drawnCards.length) {
                transaction.update(handRef(db, roomId, round, targetUid), {
                    cards: arrayUnion(...drawnCards),
                    updatedAt: serverTimestamp()
                });
            }
        }

        transaction.update(playerHandDocument, {
            cards: remainingHand,
            updatedAt: serverTimestamp()
        });

        const patch = {
            topCard: card,
            activeColor: selectedColor || card.color,
            discardPile,
            drawOrder,
            drawIndex,
            handCounts,
            ...createNextTurnPatch(state, nextTurnIndex, nextDirection),
            unoPendingUid: remainingHand.length === 1 ? uid : null,
            unoCalled: false,
            lastActionType: effect.drawCount === 2 ? "draw2" : effect.drawCount === 4 ? "wild4" : "play",
            lastActionBy: uid,
            lastActionTargetUid: targetUid,
            lastActionDrawnCards: drawnCards,
            lastPlayedCard: card,
            deckRecycledBy,
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

        if (state.unoPendingUid && !state.unoCalled && state.unoPendingUid !== uid) {
            throw new Error("Önce UNO demeyen oyuncuyu yakalayın veya oyuncunun UNO demesini bekleyin.");
        }

        const hand = Array.isArray(handSnapshot.data().cards) ? handSnapshot.data().cards : [];
        const discardPile = state.discardPile || [state.topCard];
        const result = await collectDrawCards(transaction, db, roomId, round, state, 1, discardPile, uid);
        const card = result.cards[0];

        if (!card) {
            const next = nextIndex(state, state.currentPlayerIndex, state.direction, 1);
            transaction.update(gameDocument, {
                drawOrder: result.drawOrder,
                drawIndex: result.drawIndex,
                discardPile: result.discardPile,
                deckRecycledBy: result.deckRecycledBy,
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
            drawOrder: result.drawOrder,
            drawIndex: result.drawIndex,
            discardPile: result.discardPile,
            deckRecycledBy: result.deckRecycledBy,
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
        if (state.unoPendingUid && !state.unoCalled && state.unoPendingUid !== uid) {
            throw new Error("Önce UNO demeyen oyuncuyu yakalayın veya oyuncunun UNO demesini bekleyin.");
        }
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
        const result = await collectDrawCards(
            transaction,
            db,
            roomId,
            round,
            state,
            2,
            state.discardPile || [state.topCard],
            uid
        );

        if (result.cards.length) {
            transaction.update(handRef(db, roomId, round, targetUid), {
                cards: arrayUnion(...result.cards),
                updatedAt: serverTimestamp()
            });
        }

        const handCounts = {
            ...state.handCounts,
            [targetUid]: (Number(state.handCounts[targetUid]) || 0) + result.cards.length
        };

        transaction.update(gameDocument, {
            drawOrder: result.drawOrder,
            drawIndex: result.drawIndex,
            discardPile: result.discardPile,
            deckRecycledBy: result.deckRecycledBy,
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

export function reconcileMatchPlayers(db, roomId, round, uid, lobbyMatchPlayerIds) {
    return runTransaction(db, async (transaction) => {
        const activeDocument = sessionRef(db, roomId);
        const gameDocument = matchRef(db, roomId, round);
        const activeSnapshot = await transaction.get(activeDocument);
        const gameSnapshot = await transaction.get(gameDocument);
        if (!activeSnapshot.exists() || !gameSnapshot.exists()) return false;

        const session = activeSnapshot.data();
        const state = gameSnapshot.data();
        if (session.status !== "playing" || state.status !== "playing") return false;
        if (!Array.isArray(lobbyMatchPlayerIds) || !lobbyMatchPlayerIds.includes(uid)) return false;

        const desired = state.playerIds.filter((playerId) => lobbyMatchPlayerIds.includes(playerId));
        const current = Array.isArray(state.activePlayerIds) ? state.activePlayerIds : state.playerIds;
        if (desired.length === current.length && desired.every((playerId, index) => playerId === current[index])) {
            return false;
        }

        if (desired.length === 0) return false;

        if (desired.length === 1) {
            const winnerId = desired[0];
            transaction.update(gameDocument, {
                activePlayerIds: desired,
                currentPlayerIndex: 0,
                currentPlayerUid: winnerId,
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
        if (!desired.includes(nextUid)) {
            let index = Number(state.currentPlayerIndex) || 0;
            for (let attempts = 0; attempts < state.playerIds.length; attempts += 1) {
                index = nextPlayerIndex(index, state.direction, state.playerIds.length, 1);
                const candidate = state.playerIds[index];
                if (desired.includes(candidate)) {
                    nextUid = candidate;
                    break;
                }
            }
        }

        transaction.update(gameDocument, {
            activePlayerIds: desired,
            currentPlayerIndex: desired.indexOf(nextUid),
            currentPlayerUid: nextUid,
            unoPendingUid: desired.includes(state.unoPendingUid) ? state.unoPendingUid : null,
            unoCalled: desired.includes(state.unoPendingUid) ? state.unoCalled : false,
            lastActionType: "player-left",
            lastActionBy: uid,
            updatedAt: serverTimestamp(),
            turnStartedAt: nextUid !== state.currentPlayerUid ? serverTimestamp() : state.turnStartedAt
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
