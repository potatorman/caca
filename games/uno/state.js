import {
    arrayUnion,
    deleteDoc,
    doc,
    getDoc,
    onSnapshot,
    runTransaction,
    serverTimestamp,
    writeBatch
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

function uniqueIds(values) {
    return [...new Set(Array.isArray(values) ? values.filter((value) => typeof value === "string" && value) : [])];
}

function sessionMatchPlayers(session) {
    return uniqueIds(
        Array.isArray(session?.matchPlayerIds)
            ? session.matchPlayerIds
            : session?.playerIds
    );
}

function resultReturnIds(session) {
    return uniqueIds(session?.resultReturnIds);
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
        forfeitedBy: null,
        turnNumber: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        turnStartedAt: serverTimestamp()
    };
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

function nextPlayerAfterRemoval(previousPlayers, remainingPlayers, currentUid, direction, fallbackIndex = 0) {
    if (!remainingPlayers.length) return null;
    if (remainingPlayers.includes(currentUid)) return currentUid;

    const oldCount = previousPlayers.length;
    const oldIndex = Math.max(0, fallbackIndex);
    for (let step = 1; step <= oldCount; step += 1) {
        const candidateIndex = (
            oldIndex + (direction === -1 ? -step : step) + oldCount * 2
        ) % oldCount;
        const candidate = previousPlayers[candidateIndex];
        if (remainingPlayers.includes(candidate)) return candidate;
    }
    return remainingPlayers[0];
}

export async function ensureMatch(db, roomId, round, uid) {
    return runTransaction(db, async (transaction) => {
        const activeDocument = sessionRef(db, roomId);
        const gameDocument = matchRef(db, roomId, round);
        const ownHandDocument = handRef(db, roomId, round, uid);

        const activeSnapshot = await transaction.get(activeDocument);
        const gameSnapshot = await transaction.get(gameDocument);
        if (!activeSnapshot.exists()) throw new Error("Kalıcı oyun lobisi bulunamadı.");

        const session = activeSnapshot.data();
        const players = sessionMatchPlayers(session);

        if (
            session.gameId !== "uno" ||
            session.status !== "playing" ||
            Number(session.round) !== Number(round) ||
            players.length < 2 ||
            players.length > 10 ||
            !players.includes(uid)
        ) {
            throw new Error("UNO maçı başlatılmaya hazır değil.");
        }

        if (gameSnapshot.exists()) {
            const state = gameSnapshot.data();
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

            const handSnapshot = await transaction.get(ownHandDocument);
            if (handSnapshot.exists()) return state;

            const recovered = collectDrawCards(
                state,
                7,
                state.discardPile || [state.topCard]
            );
            if (recovered.cards.length !== 7) {
                throw new Error("Oyuncunun başlangıç eli güvenli şekilde dağıtılamadı.");
            }

            const handCounts = { ...(state.handCounts || {}), [uid]: 7 };
            transaction.update(gameDocument, {
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
                ...state,
                drawPile: recovered.drawPile,
                discardPile: recovered.discardPile,
                handCounts
            };
        }

        const deck = shuffleDeck(createUnoDeck());
        const ownOpeningHand = deck.splice(0, 7);
        const openingNumberIndex = deck.findIndex((card) => card.type === "number");
        if (ownOpeningHand.length !== 7 || openingNumberIndex < 0) {
            throw new Error("UNO destesi hazırlanamadı.");
        }

        const [topCard] = deck.splice(openingNumberIndex, 1);
        const state = buildInitialState(roomId, round, players, uid, deck, topCard);

        transaction.set(gameDocument, state);
        transaction.set(ownHandDocument, {
            cards: ownOpeningHand,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

        return state;
    });
}

export async function playCard(db, roomId, round, uid, cardId, selectedColor = null) {
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
        const activePlayers = state.activePlayerIds;
        const currentIndex = state.currentPlayerIndex;
        const effect = getPlayEffect(card, activePlayers.length, state.direction);
        const nextDirection = effect.direction;
        const discardAfterPlay = [...(state.discardPile || [state.topCard]), card];

        let drawPile = [...(state.drawPile || [])];
        let discardPile = discardAfterPlay;
        const handCounts = { ...(state.handCounts || {}), [uid]: remainingHand.length };
        let nextTurnIndex = nextIndex(state, currentIndex, nextDirection, effect.steps);
        let targetHandDocument = null;
        let targetHandSnapshot = null;
        let drawnCards = [];

        if (effect.drawCount > 0) {
            const targetIndex = nextIndex(
                state,
                currentIndex,
                state.direction,
                effect.targetIndexOffset
            );
            const targetUid = activePlayers[targetIndex];
            targetHandDocument = handRef(db, roomId, round, targetUid);
            targetHandSnapshot = await transaction.get(targetHandDocument);

            if (!targetHandSnapshot.exists()) {
                throw new Error("Hedef oyuncunun kart eli henüz hazırlanmadı. Tekrar dene.");
            }

            const targetCount = Number(state.handCounts?.[targetUid]) || 0;
            const draw = collectDrawCards(state, effect.drawCount, discardAfterPlay);
            drawnCards = draw.cards;
            drawPile = draw.drawPile;
            discardPile = draw.discardPile;
            handCounts[targetUid] = targetCount + drawnCards.length;
            nextTurnIndex = nextIndex(state, targetIndex, state.direction, 1);
        }

        transaction.update(playerHandDocument, {
            cards: remainingHand,
            updatedAt: serverTimestamp()
        });

        if (targetHandDocument && drawnCards.length) {
            transaction.update(targetHandDocument, {
                cards: arrayUnion(...drawnCards),
                updatedAt: serverTimestamp()
            });
        }

        const patch = {
            topCard: card,
            activeColor: selectedColor || card.color,
            discardPile,
            drawPile,
            handCounts,
            ...createNextTurnPatch(state, nextTurnIndex, nextDirection),
            unoPendingUid: remainingHand.length === 1 ? uid : null,
            unoCalled: false,
            updatedAt: serverTimestamp(),
            forfeitedBy: null
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
        const draw = collectDrawCards(state, 1, state.discardPile || [state.topCard]);
        const card = draw.cards[0];

        if (!card) {
            const next = nextIndex(state, state.currentPlayerIndex, state.direction, 1);
            transaction.update(gameDocument, {
                drawPile: draw.drawPile,
                discardPile: draw.discardPile,
                ...createNextTurnPatch(state, next, state.direction),
                ...clearExpiredUno(state),
                updatedAt: serverTimestamp()
            });
            return { card: null, playable: false, empty: true };
        }

        const canPlay = isCardPlayable(card, state.topCard, state.activeColor, hand);
        const handAfter = [...hand, card];
        const handCounts = { ...(state.handCounts || {}), [uid]: handAfter.length };
        transaction.update(playerHandDocument, {
            cards: handAfter,
            updatedAt: serverTimestamp()
        });

        const next = canPlay
            ? state.currentPlayerIndex
            : nextIndex(state, state.currentPlayerIndex, state.direction, 1);

        transaction.update(gameDocument, {
            drawPile: draw.drawPile,
            discardPile: draw.discardPile,
            handCounts,
            ...createNextTurnPatch(state, next, state.direction, {
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
        const snapshot = await transaction.get(gameDocument);
        if (!snapshot.exists()) throw new Error("Maç bulunamadı.");

        const state = snapshot.data();
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
        const targetHandSnapshot = await transaction.get(targetHandDocument);
        if (!targetHandSnapshot.exists()) {
            throw new Error("UNO çağrısı yapan oyuncunun eli bulunamadı.");
        }

        const targetHand = Array.isArray(targetHandSnapshot.data().cards)
            ? targetHandSnapshot.data().cards
            : [];
        const draw = collectDrawCards(
            state,
            2,
            state.discardPile || [state.topCard]
        );

        transaction.update(targetHandDocument, {
            cards: [...targetHand, ...draw.cards],
            updatedAt: serverTimestamp()
        });

        const handCounts = {
            ...(state.handCounts || {}),
            [targetUid]: targetHand.length + draw.cards.length
        };
        transaction.update(gameDocument, {
            drawPile: draw.drawPile,
            discardPile: draw.discardPile,
            handCounts,
            unoPendingUid: null,
            unoCalled: false,
            updatedAt: serverTimestamp()
        });

        return { targetUid, count: draw.cards.length };
    });
}

export async function forfeitMatch(db, roomId, round, uid) {
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
        const lobbyPlayers = uniqueIds(session.playerIds);
        const lobbyMatchPlayers = sessionMatchPlayers(session);
        const activePlayers = uniqueIds(state.activePlayerIds);

        if (
            session.gameId !== "uno" ||
            Number(session.round) !== Number(round) ||
            !["playing", "results"].includes(session.status) ||
            state.roomId !== roomId ||
            Number(state.round) !== Number(round)
        ) {
            throw new Error("Bu UNO turu artık aktif değil.");
        }

        // Repair a forfeit that was committed to the match by an older build,
        // but whose second write to the persistent lobby failed.
        const isLegacyPartialForfeit =
            state.forfeitedBy === uid &&
            !activePlayers.includes(uid) &&
            lobbyPlayers.includes(uid) &&
            lobbyMatchPlayers.includes(uid);

        if (isLegacyPartialForfeit) {
            const nextLobbyPlayers = lobbyPlayers.filter((id) => id !== uid);
            const nextMatchPlayers = lobbyMatchPlayers.filter((id) => id !== uid);
            if (
                !nextLobbyPlayers.length ||
                nextMatchPlayers.length !== activePlayers.length ||
                !nextMatchPlayers.every((id, index) => id === activePlayers[index])
            ) {
                throw new Error("Eski maçtan ayrılma kaydı tutarsız; otomatik düzeltilemedi.");
            }

            const nextHostId = session.hostId === uid
                ? nextLobbyPlayers[0]
                : session.hostId;
            const updates = {
                status: state.status,
                hostId: nextHostId,
                playerIds: nextLobbyPlayers,
                readyIds: state.status === "results"
                    ? []
                    : uniqueIds(session.readyIds).filter((id) => id !== uid),
                matchPlayerIds: nextMatchPlayers,
                resultReturnIds: [],
                updatedAt: serverTimestamp()
            };

            if (state.status === "results") {
                updates.nextRoundPlayerIds = [];
                updates.nextRoundReadyIds = [];
                updates.finishedAt = state.finishedAt || serverTimestamp();
            }

            transaction.update(activeDocument, updates);
            return {
                left: true,
                finished: state.status === "results",
                winner: state.winnerId || null,
                recovered: true
            };
        }

        if (
            session.status !== "playing" ||
            state.status !== "playing" ||
            !lobbyPlayers.includes(uid) ||
            !lobbyMatchPlayers.includes(uid) ||
            !activePlayers.includes(uid)
        ) {
            throw new Error("Bu maçta artık aktif oyuncu değilsin.");
        }

        const nextLobbyPlayers = lobbyPlayers.filter((id) => id !== uid);
        const nextMatchPlayers = lobbyMatchPlayers.filter((id) => id !== uid);
        const nextActivePlayers = activePlayers.filter((id) => id !== uid);

        if (
            !nextLobbyPlayers.length ||
            nextMatchPlayers.length !== nextActivePlayers.length ||
            !nextMatchPlayers.every((id, index) => id === nextActivePlayers[index]) ||
            !nextActivePlayers.length
        ) {
            throw new Error("UNO oyuncu listeleri eşleşmiyor; çıkış güvenli biçimde durduruldu.");
        }

        const oldIndex = Math.max(0, activePlayers.indexOf(state.currentPlayerUid));
        const nextCurrentUid = nextPlayerAfterRemoval(
            activePlayers,
            nextActivePlayers,
            state.currentPlayerUid,
            state.direction,
            oldIndex
        );
        const winnerId = nextActivePlayers.length === 1 ? nextActivePlayers[0] : null;
        const isHost = session.hostId === uid;
        const nextHostId = isHost ? nextLobbyPlayers[0] : session.hostId;
        const changedAt = serverTimestamp();

        const matchUpdates = {
            activePlayerIds: nextActivePlayers,
            currentPlayerIndex: nextActivePlayers.indexOf(winnerId || nextCurrentUid),
            currentPlayerUid: winnerId || nextCurrentUid,
            drewCardId: null,
            forfeitedBy: uid,
            unoPendingUid: nextActivePlayers.includes(state.unoPendingUid)
                ? state.unoPendingUid
                : null,
            unoCalled: nextActivePlayers.includes(state.unoPendingUid)
                ? state.unoCalled
                : false,
            updatedAt: changedAt
        };

        const sessionUpdates = {
            status: winnerId ? "results" : "playing",
            hostId: nextHostId,
            playerIds: nextLobbyPlayers,
            readyIds: winnerId
                ? []
                : uniqueIds(session.readyIds).filter((id) => id !== uid),
            matchPlayerIds: nextMatchPlayers,
            resultReturnIds: [],
            updatedAt: changedAt
        };

        if (winnerId) {
            matchUpdates.status = "results";
            matchUpdates.winnerId = winnerId;
            matchUpdates.finishedAt = changedAt;

            sessionUpdates.nextRoundPlayerIds = [];
            sessionUpdates.nextRoundReadyIds = [];
            sessionUpdates.finishedAt = changedAt;
        } else {
            matchUpdates.status = "playing";
            matchUpdates.winnerId = null;
            matchUpdates.turnStartedAt = nextCurrentUid !== state.currentPlayerUid
                ? changedAt
                : state.turnStartedAt;
            sessionUpdates.finishedAt = null;
        }

        transaction.update(gameDocument, matchUpdates);
        transaction.update(activeDocument, sessionUpdates);

        return { left: true, finished: Boolean(winnerId), winner: winnerId };
    });
}

export async function returnToLobby(db, roomId, round, uid) {
    const activeDocument = sessionRef(db, roomId);
    const gameDocument = matchRef(db, roomId, round);

    // First acknowledge only this player's return. No other player is moved
    // until every remaining match player has made the same choice.
    const acknowledgement = await runTransaction(db, async (transaction) => {
        const activeSnapshot = await transaction.get(activeDocument);
        const gameSnapshot = await transaction.get(gameDocument);
        if (!activeSnapshot.exists() || !gameSnapshot.exists()) {
            throw new Error("UNO maç sonucu veya oyun lobisi bulunamadı.");
        }

        const session = activeSnapshot.data();
        const match = gameSnapshot.data();
        if (
            session.gameId !== "uno" ||
            Number(session.round) !== Number(round) ||
            match.roomId !== roomId ||
            Number(match.round) !== Number(round) ||
            match.status !== "results"
        ) {
            throw new Error("Bu UNO maçının sonuçları artık güncel değil.");
        }

        const matchPlayers = sessionMatchPlayers(session);
        if (!matchPlayers.includes(uid)) {
            throw new Error("Bu oyuncu artık sonuç ekranında aktif maç oyuncusu değil.");
        }

        if (session.status === "playing") {
            if (
                !match.winnerId ||
                !matchPlayers.includes(match.winnerId) ||
                !matchPlayers.every((id) => match.activePlayerIds?.includes(id))
            ) {
                throw new Error("UNO kazananı veya aktif oyuncu listesi doğrulanamadı.");
            }

            transaction.update(activeDocument, {
                status: "results",
                resultReturnIds: [uid],
                finishedAt: match.finishedAt || serverTimestamp(),
                updatedAt: serverTimestamp()
            });

            return {
                matchPlayers,
                returnedIds: [uid],
                alreadyReturned: false
            };
        }

        if (session.status !== "results") {
            throw new Error("Oyun oturumu sonuç ekranında değil.");
        }

        const currentReturns = resultReturnIds(session);
        if (currentReturns.includes(uid)) {
            return {
                matchPlayers,
                returnedIds: currentReturns,
                alreadyReturned: true
            };
        }

        const nextReturns = [...currentReturns, uid];
        transaction.update(activeDocument, {
            resultReturnIds: nextReturns,
            updatedAt: serverTimestamp()
        });

        return {
            matchPlayers,
            returnedIds: nextReturns,
            alreadyReturned: false
        };
    });

    const allReturned = acknowledgement.matchPlayers.length > 0 &&
        acknowledgement.matchPlayers.every((playerId) =>
            acknowledgement.returnedIds.includes(playerId)
        );

    if (!allReturned) {
        return {
            completed: false,
            alreadyReturned: acknowledgement.alreadyReturned,
            returnedCount: acknowledgement.returnedIds.length,
            requiredCount: acknowledgement.matchPlayers.length,
            waitingFor: acknowledgement.matchPlayers.filter((id) =>
                !acknowledgement.returnedIds.includes(id)
            )
        };
    }

    const completed = await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(activeDocument);
        if (!snapshot.exists()) throw new Error("Oyun lobisi bulunamadı.");

        const session = snapshot.data();
        if (
            session.gameId !== "uno" ||
            session.status !== "results" ||
            Number(session.round) !== Number(round)
        ) {
            if (session.gameId === "uno" &&
                session.status === "lobby" &&
                Number(session.round) === Number(round) + 1) {
                return { completed: true, alreadyCompleted: true };
            }
            throw new Error("UNO sonuç onayları değişti. Lobi geçişi yeniden denenmeli.");
        }

        const matchPlayers = sessionMatchPlayers(session);
        const returnedIds = resultReturnIds(session);
        if (
            !matchPlayers.length ||
            !matchPlayers.every((playerId) => returnedIds.includes(playerId))
        ) {
            return { completed: false };
        }

        const nextPlayers = uniqueIds([
            ...uniqueIds(session.playerIds),
            ...uniqueIds(session.spectatorIds),
            ...uniqueIds(session.nextRoundPlayerIds)
        ]);
        if (nextPlayers.length > 10) {
            throw new Error("Sonraki lobi UNO oyuncu sınırını aşıyor.");
        }

        transaction.update(activeDocument, {
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

    if (!completed.completed) {
        return {
            completed: false,
            returnedCount: acknowledgement.returnedIds.length,
            requiredCount: acknowledgement.matchPlayers.length,
            waitingFor: acknowledgement.matchPlayers.filter((id) =>
                !acknowledgement.returnedIds.includes(id)
            )
        };
    }

    if (!completed.alreadyCompleted) {
        // Cleanup is not part of the lobby transition. A cleanup failure cannot
        // undo the next lobby or close another player's result screen.
        try {
            const matchSnapshot = await getDoc(gameDocument);
            if (matchSnapshot.exists()) {
                const match = matchSnapshot.data();
                const cleanupPlayers = uniqueIds(match.playerIds);
                for (let index = 0; index < cleanupPlayers.length; index += 4) {
                    const batch = writeBatch(db);
                    cleanupPlayers.slice(index, index + 4).forEach((playerId) => {
                        batch.delete(handRef(db, roomId, round, playerId));
                    });
                    await batch.commit();
                }
                await deleteDoc(gameDocument);
            }
        } catch (error) {
            console.warn("CACA UNO old match cleanup failed:", error);
        }
    }

    return {
        completed: true,
        round: Number(round) + 1,
        returnedCount: acknowledgement.matchPlayers.length,
        requiredCount: acknowledgement.matchPlayers.length
    };
}

export async function skipTimedOutTurn(db, roomId, round, uid, timeoutMs = 90000) {
    return runTransaction(db, async (transaction) => {
        const gameDocument = matchRef(db, roomId, round);
        const snapshot = await transaction.get(gameDocument);
        if (!snapshot.exists()) return false;

        const state = snapshot.data();
        requirePlayingMatch(state, uid);

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

export async function reconcileMatchPlayers(db, roomId, round, uid) {
    return runTransaction(db, async (transaction) => {
        const activeDocument = sessionRef(db, roomId);
        const gameDocument = matchRef(db, roomId, round);
        const activeSnapshot = await transaction.get(activeDocument);
        const gameSnapshot = await transaction.get(gameDocument);
        if (!activeSnapshot.exists() || !gameSnapshot.exists()) return false;

        const session = activeSnapshot.data();
        const state = gameSnapshot.data();
        if (
            session.gameId !== "uno" ||
            session.status !== "playing" ||
            Number(session.round) !== Number(round) ||
            state.status !== "playing"
        ) {
            return false;
        }

        const allowedPlayers = sessionMatchPlayers(session);
        if (!allowedPlayers.includes(uid)) return false;

        const oldPlayers = uniqueIds(state.activePlayerIds);
        const remainingPlayers = oldPlayers.filter((id) => allowedPlayers.includes(id));
        if (
            !remainingPlayers.length ||
            (remainingPlayers.length === oldPlayers.length &&
                remainingPlayers.every((id, index) => id === oldPlayers[index]))
        ) {
            return false;
        }

        const nextUid = nextPlayerAfterRemoval(
            oldPlayers,
            remainingPlayers,
            state.currentPlayerUid,
            state.direction,
            state.currentPlayerIndex
        );
        const isFinished = remainingPlayers.length === 1;
        const changedAt = serverTimestamp();
        const updates = {
            activePlayerIds: remainingPlayers,
            currentPlayerIndex: remainingPlayers.indexOf(isFinished ? remainingPlayers[0] : nextUid),
            currentPlayerUid: isFinished ? remainingPlayers[0] : nextUid,
            drewCardId: null,
            unoPendingUid: remainingPlayers.includes(state.unoPendingUid)
                ? state.unoPendingUid
                : null,
            unoCalled: remainingPlayers.includes(state.unoPendingUid)
                ? state.unoCalled
                : false,
            updatedAt: changedAt
        };

        if (isFinished) {
            updates.status = "results";
            updates.winnerId = remainingPlayers[0];
            updates.finishedAt = changedAt;
        } else if (nextUid !== state.currentPlayerUid) {
            updates.turnStartedAt = changedAt;
        }

        transaction.update(gameDocument, updates);
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
        }, (error) => onError(error, "Kartların")));
    }

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}
