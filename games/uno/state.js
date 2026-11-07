import {
    arrayUnion,
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

function buildInitialState(roomId, round, playerIds, dealerId, drawPile, topCard) {
    const handCounts = {};
    playerIds.forEach((uid) => { handCounts[uid] = 7; });

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
        drawPile: [...drawPile],
        handCounts,
        drewCardId: null,
        unoPendingUid: null,
        unoCalled: false,
        winnerId: null,
        turnNumber: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        turnStartedAt: serverTimestamp()
    };
}

export async function ensureMatch(db, roomId, round, uid, { recoverStaleSession = false } = {}) {
    return runTransaction(db, async (transaction) => {
        const activeRef = sessionRef(db, roomId);
        const gameRef = matchRef(db, roomId, round);
        const ownHandDocument = handRef(db, roomId, round, uid);
        const matchSnapshot = await transaction.get(gameRef);

        if (matchSnapshot.exists()) {
            const existingState = matchSnapshot.data();
            const activeSnapshot = await transaction.get(activeRef);
            if (!activeSnapshot.exists()) {
                throw new Error("Kalıcı oyun lobisi bulunamadı.");
            }

            const session = activeSnapshot.data();
            const activePlayers = Array.isArray(session.matchPlayerIds) ? session.matchPlayerIds : [];
            if (
                session.status !== "playing" ||
                session.gameId !== "uno" ||
                Number(session.round) !== Number(round) ||
                !activePlayers.includes(uid)
            ) {
                throw new Error("Bu UNO turu artık aktif değil. Lobi ekranını yenileyip güncel tura gir.");
            }

            // A previous deployment could leave the lobby marked as "playing"
            // while its UNO match document had already reached results. Recover
            // the lobby into a fresh round instead of trapping the player here.
            if (
                existingState.status !== "playing" ||
                Number(existingState.round) !== Number(round) ||
                existingState.roomId !== roomId
            ) {
                if (!recoverStaleSession) {
                    throw new Error("Bu UNO turunda eski maç kaydı var. Önce oyun merkezindeki lobi durumunu yenile.");
                }

                const lobbyPlayers = Array.isArray(session.playerIds) ? session.playerIds : [];
                const spectators = Array.isArray(session.spectatorIds) ? session.spectatorIds : [];
                const queuedPlayers = Array.isArray(session.nextRoundPlayerIds)
                    ? session.nextRoundPlayerIds
                    : [];
                const nextPlayers = [...new Set([...lobbyPlayers, ...spectators, ...queuedPlayers])];

                if (nextPlayers.length > 10) {
                    throw new Error("Eski maç düzeltilemedi: sonraki lobi UNO oyuncu sınırını aşıyor.");
                }

                // Remove the finished/stale match and every private hand document.
                // Firestore does not cascade-delete subcollections when a parent is deleted.
                const stalePlayerIds = [...new Set([
                    ...(Array.isArray(existingState.playerIds) ? existingState.playerIds : []),
                    ...(Array.isArray(existingState.activePlayerIds) ? existingState.activePlayerIds : []),
                    ...(Array.isArray(session.matchPlayerIds) ? session.matchPlayerIds : [])
                ])];
                stalePlayerIds.forEach((playerId) => {
                    transaction.delete(handRef(db, roomId, round, playerId));
                });
                transaction.delete(gameRef);

                transaction.update(activeRef, {
                    // Keep the session playing with the same frozen roster.
                    // The new round number makes every client open a fresh match
                    // without asking everyone to ready up again.
                    round: Number(session.round) + 1,
                    startedAt: serverTimestamp(),
                    countdownEndsAt: null,
                    finishedAt: null,
                    updatedAt: serverTimestamp()
                });

                return {
                    sessionAdvanced: true,
                    nextRound: Number(session.round) + 1
                };
            }

            if (!Array.isArray(existingState.activePlayerIds) || !existingState.activePlayerIds.includes(uid)) {
                throw new Error("Bu turda aktif oyuncu değilsin.");
            }

            const ownHandSnapshot = await transaction.get(ownHandDocument);
            if (ownHandSnapshot.exists()) {
                return existingState;
            }

            // Recover a missing private hand without exposing another player's cards.
            const recovered = collectDrawCards(
                existingState,
                7,
                existingState.discardPile || [existingState.topCard]
            );
            if (recovered.cards.length !== 7) {
                throw new Error("Eksik oyuncu eli güvenli şekilde tamamlanamadı.");
            }

            const handCounts = {
                ...(existingState.handCounts || {}),
                [uid]: 7
            };
            transaction.update(gameRef, {
                drawPile: recovered.drawPile,
                discardPile: recovered.discardPile,
                handCounts,
                updatedAt: serverTimestamp()
            });
            transaction.set(ownHandDocument, {
                cards: recovered.cards,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });

            return {
                ...existingState,
                drawPile: recovered.drawPile,
                discardPile: recovered.discardPile,
                handCounts
            };
        }

        const activeSnapshot = await transaction.get(activeRef);
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
        const ownHandStart = playerIds.indexOf(uid) * 7;
        const ownOpeningHand = deck.splice(ownHandStart, 7);
        const openingNumberIndex = deck.findIndex((card) => card.type === "number");

        if (ownOpeningHand.length !== 7 || openingNumberIndex < 0) {
            throw new Error("Açılış kartları oluşturulamadı.");
        }

        const [topCard] = deck.splice(openingNumberIndex, 1);
        const state = buildInitialState(roomId, round, playerIds, uid, deck, topCard);

        transaction.set(gameRef, state);
        transaction.set(ownHandDocument, {
            cards: ownOpeningHand,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        // Every client creates only its own private hand. Other players recover
        // their opening seven cards from the shared draw pile in ensureMatch().
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
    // First commit the actual card play and match result. The lobby result is
    // finalized in a second transaction after the winning match document exists.
    const result = await runTransaction(db, async (transaction) => {
        const gameDocument = matchRef(db, roomId, round);
        const playerHandDocument = handRef(db, roomId, round, uid);
        const gameSnapshot = await transaction.get(gameDocument);
        const handSnapshot = await transaction.get(playerHandDocument);

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
        const isWinningPlay = remainingHand.length === 0;
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

        const activeSessionSnapshot = isWinningPlay
            ? await transaction.get(sessionRef(db, roomId))
            : null;
        if (isWinningPlay && (
            !activeSessionSnapshot?.exists() ||
            activeSessionSnapshot.data().status !== "playing" ||
            activeSessionSnapshot.data().gameId !== "uno" ||
            Number(activeSessionSnapshot.data().round) !== Number(round) ||
            !activeSessionSnapshot.data().matchPlayerIds?.includes(uid)
        )) {
            throw new Error("Son kartı oynayabilmek için aktif UNO maç kaydı doğrulanamadı.");
        }

        if (effect.drawCount > 0) {
            const targetIndex = nextIndex(state, currentIndex, state.direction, effect.targetIndexOffset);
            targetUid = playerIds[targetIndex];
            targetHandDocument = handRef(db, roomId, round, targetUid);
            const targetCardCount = Number(state.handCounts?.[targetUid]) || 0;

            const drawResult = collectDrawCards(state, effect.drawCount, discardAfterPlay);
            drawnCards = drawResult.cards;
            drawPile = drawResult.drawPile;
            discardPile = drawResult.discardPile;
            handCounts[targetUid] = targetCardCount + drawnCards.length;
            nextTurnIndex = nextIndex(state, targetIndex, state.direction, 1);
        }

        // A winning card ends the round, so its effect must not block the win
        // by requiring an additional write to the next player's private hand.
        if (targetHandDocument && drawnCards.length) {
            transaction.update(targetHandDocument, {
                cards: arrayUnion(...drawnCards),
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
            updatedAt: serverTimestamp()
        };

        if (isWinningPlay) {
            patch.status = "results";
            patch.winnerId = uid;
            patch.currentPlayerIndex = currentIndex;
            patch.currentPlayerUid = uid;
            patch.direction = state.direction;
            patch.drewCardId = null;
            patch.unoPendingUid = null;
            patch.unoCalled = false;
            patch.finishedAt = serverTimestamp();
        }

        transaction.update(gameDocument, patch);
        return { winner: isWinningPlay, card };
    });

    if (result.winner) {
        try {
            await runTransaction(db, async (transaction) => {
                const activeDocument = sessionRef(db, roomId);
                const gameDocument = matchRef(db, roomId, round);
                const activeSnapshot = await transaction.get(activeDocument);
                const gameSnapshot = await transaction.get(gameDocument);

                if (!activeSnapshot.exists() || !gameSnapshot.exists()) {
                    throw new Error("Maç sonucu veya kalıcı lobi bulunamadı.");
                }

                const session = activeSnapshot.data();
                const finishedMatch = gameSnapshot.data();

                if (
                    finishedMatch.status !== "results" ||
                    finishedMatch.winnerId !== uid ||
                    Number(finishedMatch.round) !== Number(round)
                ) {
                    throw new Error("Son kart kaydedildi ancak kazanan bilgisi doğrulanamadı.");
                }

                // Another client may already have completed this second phase.
                if (
                    session.status === "results" &&
                    session.gameId === "uno" &&
                    Number(session.round) === Number(round)
                ) {
                    return;
                }

                if (
                    session.status !== "playing" ||
                    session.gameId !== "uno" ||
                    Number(session.round) !== Number(round) ||
                    !session.matchPlayerIds?.includes(uid)
                ) {
                    throw new Error("Son kart kaydedildi ancak oyun lobisi sonuç durumuna geçirilemedi.");
                }

                transaction.update(activeDocument, makeResultSessionPatch(session));
            });
        } catch (error) {
            throw new Error(
                "Son kart oynandı ve kazanç kaydedildi; sonuç ekranı eşitlenirken hata oluştu: " +
                (error.message || "Bilinmeyen hata")
            );
        }
    }

    return result;
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
                drewCardId: canPlay ? card.id : null
            }),
            unoPendingUid: null,
            unoCalled: false,
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
        const targetCardCount = Number(state.handCounts?.[targetUid]) || 0;

        const result = collectDrawCards(
            state,
            2,
            state.discardPile || [state.topCard]
        );

        if (result.cards.length) {
            transaction.update(targetHandDocument, {
                cards: arrayUnion(...result.cards),
                updatedAt: serverTimestamp()
            });
        }

        const handCounts = {
            ...state.handCounts,
            [targetUid]: targetCardCount + result.cards.length
        };

        transaction.update(gameDocument, {
            drawPile: result.drawPile,
            discardPile: result.discardPile,
            handCounts,
            unoPendingUid: null,
            unoCalled: false,
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
                status: "results",
                winnerId,
                unoPendingUid: null,
                unoCalled: false,
                finishedAt: serverTimestamp(),
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
            unoPendingUid: remainingPlayers.includes(state.unoPendingUid) ? state.unoPendingUid : null,
            unoCalled: remainingPlayers.includes(state.unoPendingUid) ? state.unoCalled : false,
            updatedAt: serverTimestamp(),
            turnStartedAt: currentPlayerChanged ? serverTimestamp() : state.turnStartedAt
        });
        return true;
    });
}

export function forfeitMatch(db, roomId, round, uid) {
    return runTransaction(db, async (transaction) => {
        const activeDocument = sessionRef(db, roomId);
        const gameDocument = matchRef(db, roomId, round);
        const activeSnapshot = await transaction.get(activeDocument);
        const gameSnapshot = await transaction.get(gameDocument);

        if (!activeSnapshot.exists() || !gameSnapshot.exists()) {
            throw new Error("Aktif UNO maçı bulunamadı.");
        }

        const session = activeSnapshot.data();
        const state = gameSnapshot.data();
        const lobbyPlayers = Array.isArray(session.playerIds) ? session.playerIds : [];
        const lobbyMatchPlayers = Array.isArray(session.matchPlayerIds)
            ? session.matchPlayerIds
            : lobbyPlayers;
        const activePlayers = Array.isArray(state.activePlayerIds)
            ? state.activePlayerIds
            : state.playerIds;

        if (
            session.status !== "playing" ||
            session.gameId !== "uno" ||
            Number(session.round) !== Number(round) ||
            state.status !== "playing" ||
            !lobbyMatchPlayers.includes(uid) ||
            !activePlayers.includes(uid) ||
            !lobbyPlayers.includes(uid)
        ) {
            throw new Error("Bu maçta artık aktif oyuncu değilsin.");
        }

        const remainingLobbyPlayers = lobbyPlayers.filter((id) => id !== uid);
        const remainingActivePlayers = activePlayers.filter((id) => id !== uid);
        const isHost = session.hostId === uid;
        if (!remainingLobbyPlayers.length || !remainingActivePlayers.length) {
            throw new Error("Maçta kazanan kalmayacağı için bu çıkış şu anda yapılamıyor.");
        }

        const nextHostId = isHost ? remainingLobbyPlayers[0] : session.hostId;
        const changedAt = serverTimestamp();
        let nextCurrentUid = state.currentPlayerUid;

        if (!remainingActivePlayers.includes(nextCurrentUid)) {
            const oldIndex = Math.max(0, activePlayers.indexOf(state.currentPlayerUid));
            nextCurrentUid = remainingActivePlayers[0];
            for (let step = 1; step <= activePlayers.length; step += 1) {
                const candidateIndex = (
                    oldIndex + (state.direction === -1 ? -step : step) + activePlayers.length * 2
                ) % activePlayers.length;
                const candidate = activePlayers[candidateIndex];
                if (remainingActivePlayers.includes(candidate)) {
                    nextCurrentUid = candidate;
                    break;
                }
            }
        }

        const winnerId = remainingActivePlayers.length === 1
            ? remainingActivePlayers[0]
            : null;

        if (winnerId) {
            transaction.update(gameDocument, {
                activePlayerIds: remainingActivePlayers,
                currentPlayerIndex: 0,
                currentPlayerUid: winnerId,
                drewCardId: null,
                status: "results",
                winnerId,
                forfeitedBy: uid,
                unoPendingUid: null,
                unoCalled: false,
                finishedAt: changedAt,
                updatedAt: changedAt
            });

            transaction.update(activeDocument, {
                status: "results",
                hostId: nextHostId,
                playerIds: remainingLobbyPlayers,
                readyIds: [],
                matchPlayerIds: remainingActivePlayers,
                nextRoundPlayerIds: [],
                nextRoundReadyIds: [],
                finishedAt: changedAt,
                updatedAt: changedAt
            });

            return { left: true, finished: true, winner: winnerId };
        }

        const currentPlayerChanged = nextCurrentUid !== state.currentPlayerUid;
        transaction.update(gameDocument, {
            activePlayerIds: remainingActivePlayers,
            forfeitedBy: uid,
            currentPlayerIndex: remainingActivePlayers.indexOf(nextCurrentUid),
            currentPlayerUid: nextCurrentUid,
            drewCardId: currentPlayerChanged ? null : state.drewCardId,
            unoPendingUid: remainingActivePlayers.includes(state.unoPendingUid) ? state.unoPendingUid : null,
            unoCalled: remainingActivePlayers.includes(state.unoPendingUid) ? state.unoCalled : false,
            updatedAt: changedAt,
            turnStartedAt: currentPlayerChanged ? changedAt : state.turnStartedAt
        });

        transaction.update(activeDocument, {
            hostId: nextHostId,
            playerIds: remainingLobbyPlayers,
            readyIds: (session.readyIds || []).filter((id) => id !== uid),
            matchPlayerIds: remainingActivePlayers,
            updatedAt: changedAt
        });

        return { left: true, finished: false, winner: null };
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
            updatedAt: serverTimestamp()
        });
        return true;
    });
}

export function subscribeToMatch(db, roomId, round, uid, onState, onHand, onError, watchHand = true) {
    const unsubscribers = [
        onSnapshot(matchRef(db, roomId, round), (snapshot) => {
            onState(snapshot.exists() ? snapshot.data() : null);
        }, (error) => onError(error, "Maç verisi"))
    ];

    if (watchHand) {
        unsubscribers.push(onSnapshot(handRef(db, roomId, round, uid), (snapshot) => {
            onHand(snapshot.exists() ? snapshot.data() : null);
        }, (error) => onError(error, "Kartların"))
        );
    }

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}
