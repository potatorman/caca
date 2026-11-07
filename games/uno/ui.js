import { getDoc, doc } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { setAvatarElement } from "../../js/avatars.js";
import { isCardPlayable } from "./engine.js";
import {
    callUno,
    catchUno,
    drawOneCard,
    endTurnAfterDraw,
    ensureMatch,
    playCard,
    skipTimedOutTurn,
    subscribeToMatch
} from "./state.js";

const COLOR_LABELS = {
    red: "Kırmızı",
    yellow: "Sarı",
    green: "Yeşil",
    blue: "Mavi"
};

const CARD_LABELS = {
    skip: "PAS",
    reverse: "YÖN",
    draw2: "+2",
    wild: "RENK",
    wild4: "+4"
};

function cardLabel(card) {
    return CARD_LABELS[card.type] || card.value;
}

function playerLabel(playerId, members, profiles) {
    const member = members.find((item) => item.id === playerId);
    const profile = profiles[playerId];
    return member?.displayNickname || member?.username || profile?.nickname || profile?.username || "Oyuncu";
}

export async function openUnoGame({ db, roomId, round, uid, session, roomMembers = [], onLeave, onReturnToLobby }) {
    const root = document.createElement("section");
    root.className = "uno-overlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "UNO masası");

    root.innerHTML = `
        <div class="uno-shell">
            <header class="uno-header">
                <div>
                    <span class="uno-eyebrow">CACA · ROOM GAME</span>
                    <h2>UNO</h2>
                    <p class="uno-header-status" data-role="status">Masa hazırlanıyor…</p>
                </div>
                <div class="uno-header-actions">
                    <button type="button" class="uno-secondary" data-action="leave">Maçı terk et</button>
                    <button type="button" class="uno-close" data-action="close" aria-label="Oyunu kapat">×</button>
                </div>
            </header>
            <div class="uno-board">
                <div class="uno-players" data-role="players"></div>
                <div class="uno-table">
                    <div class="uno-turn-pill" data-role="turn">Sıra bekleniyor</div>
                    <div class="uno-center-piles">
                        <button class="uno-draw-pile" type="button" data-action="draw">
                            <span>UNO</span><small data-role="draw-count">0</small>
                        </button>
                        <div class="uno-discard-pile" data-role="discard"></div>
                    </div>
                    <div class="uno-active-color" data-role="active-color">Aktif renk: —</div>
                    <div class="uno-direction" data-role="direction">Yön: →</div>
                    <p class="uno-message" data-role="message" aria-live="polite"></p>
                </div>
                <div class="uno-hand-area" data-role="hand-area">
                    <div class="uno-hand-heading">
                        <strong>Senin kartların</strong>
                        <div class="uno-hand-heading-actions">
                            <span data-role="hand-count">0 kart</span>
                            <button class="uno-secondary uno-hand-visibility" type="button"
                                data-action="toggle-hand-visibility" aria-pressed="false">
                                Kartları gizle
                            </button>
                        </div>
                    </div>
                    <div class="uno-hand-viewport" data-role="hand-viewport">
                        <div class="uno-hand" data-role="hand"></div>
                        <div class="uno-hand-cover" data-role="hand-cover" hidden aria-hidden="true">
                            <strong>KARTLAR GİZLİ</strong>
                            <span>Göstermek için butona bas</span>
                        </div>
                    </div>
                </div>
                <div class="uno-controls">
                    <button class="uno-primary" type="button" data-action="uno" hidden>UNO!</button>
                    <button class="uno-primary uno-catch" type="button" data-action="catch" hidden>UNO'yu yakala · +2</button>
                    <button class="uno-secondary" type="button" data-action="end-turn" hidden>Sıramı bitir</button>
                </div>
            </div>
            <div class="uno-color-modal" data-role="color-modal" hidden>
                <div class="uno-color-card">
                    <h3>Yeni rengi seç</h3>
                    <p>Renk değiştir kartının rengini belirle.</p>
                    <div class="uno-color-options">
                        <button type="button" data-color="red" aria-label="Kırmızı"></button>
                        <button type="button" data-color="yellow" aria-label="Sarı"></button>
                        <button type="button" data-color="green" aria-label="Yeşil"></button>
                        <button type="button" data-color="blue" aria-label="Mavi"></button>
                    </div>
                </div>
            </div>
            <div class="uno-result-modal" data-role="result" hidden>
                <div class="uno-result-card">
                    <span class="uno-eyebrow">MAÇ SONUCU</span>
                    <h2 data-role="winner">Kazanan</h2>
                    <div data-role="result-scores"></div>
                    <p class="uno-message uno-result-message" data-role="result-message" aria-live="assertive"></p>
                    <button class="uno-primary" type="button" data-action="close-result">Yeni tur için lobiye dön</button>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(root);

    const $ = (role) => root.querySelector('[data-role="' + role + '"]');
    const action = (name) => root.querySelector('[data-action="' + name + '"]');
    const members = Array.isArray(roomMembers) ? roomMembers : [];
    const profiles = {};
    let matchState = null;
    let handData = null;
    let selectedWildCardId = null;
    let unsubscribeMatch = null;
    let timeoutTimer = null;
    let timeoutAttemptedKey = null;
    let handHidden = false;
    let cardActionInProgress = false;
    let profileRenderVersion = 0;
    const profileLoads = new Map();
    let closed = false;

    $("hand-area").hidden = !(
        session?.status === "playing" &&
        Array.isArray(session?.matchPlayerIds) &&
        session.matchPlayerIds.includes(uid)
    );
    action("leave").hidden = !(
        session?.status === "playing" &&
        Array.isArray(session?.matchPlayerIds) &&
        session.matchPlayerIds.includes(uid)
    );

    const setMessage = (message, error = false) => {
        const inResults = $("result") && !$("result").hidden;
        const target = inResults ? $("result-message") : $("message");
        target.textContent = message || "";
        target.classList.toggle("is-error", Boolean(error));
    };

    const setStatus = (message) => {
        $("status").textContent = message || "";
    };

    const loadProfiles = async (playerIds) => {
        await Promise.all(playerIds.map((playerId) => {
            if (profiles[playerId]) return Promise.resolve();

            const known = members.find((item) => item.id === playerId);
            if (known) {
                profiles[playerId] = {
                    username: known.username,
                    nickname: known.displayNickname || known.username,
                    avatarId: known.avatarId,
                    avatarData: known.avatarData
                };
                return Promise.resolve();
            }

            if (profileLoads.has(playerId)) return profileLoads.get(playerId);

            const pending = getDoc(doc(db, "users", playerId))
                .then((snapshot) => {
                    if (snapshot.exists()) profiles[playerId] = snapshot.data();
                    else profiles[playerId] = { username: "Oyuncu" };
                })
                .catch(() => {
                    profiles[playerId] = { username: "Oyuncu" };
                })
                .finally(() => profileLoads.delete(playerId));

            profileLoads.set(playerId, pending);
            return pending;
        }));
    };

    const renderPlayers = () => {
        const container = $("players");
        container.replaceChildren();
        if (!matchState) return;

        matchState.playerIds.forEach((playerId) => {
            const count = Number(matchState.handCounts?.[playerId]) || 0;
            const isActive = matchState.activePlayerIds?.includes(playerId);
            const isCurrent = matchState.currentPlayerUid === playerId;
            const card = document.createElement("article");
            card.className = "uno-player" + (isCurrent ? " is-current" : "") + (!isActive ? " is-left" : "");

            const avatar = document.createElement("span");
            avatar.className = "uno-avatar";
            const profile = profiles[playerId] || {};
            setAvatarElement(avatar, profile.avatarId, profile.avatarData);

            const details = document.createElement("span");
            details.className = "uno-player-details";
            const name = document.createElement("strong");
            name.textContent = playerLabel(playerId, members, profiles) + (playerId === uid ? " · Sen" : "");
            const cards = document.createElement("small");
            cards.textContent = isActive ? count + " kart" : "Maçtan ayrıldı";
            details.append(name, cards);

            const marker = document.createElement("span");
            marker.className = "uno-player-turn";
            marker.textContent = isCurrent ? "SIRA" : "";

            card.append(avatar, details, marker);
            container.appendChild(card);
        });
    };

    const renderHand = () => {
        const container = $("hand");
        container.replaceChildren();
        const cards = Array.isArray(handData?.cards) ? handData.cards : [];
        $("hand-count").textContent = cards.length + " kart";

        cards.forEach((card, index) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "uno-card uno-card-" + (card.color || "wild");
            button.dataset.cardId = card.id;
            button.style.setProperty("--card-index", String(index));
            const isMyTurn = matchState?.status === "playing" && matchState.currentPlayerUid === uid;
            const playable = isMyTurn && isCardPlayable(
                card,
                matchState.topCard,
                matchState.activeColor,
                cards
            ) && (!matchState.drewCardId || matchState.drewCardId === card.id);
            button.disabled = !playable || handHidden || cardActionInProgress;
            button.classList.toggle("is-playable", Boolean(playable));
            const value = document.createElement("span");
            value.className = "uno-card-value";
            value.textContent = cardLabel(card);
            const corner = document.createElement("small");
            corner.textContent = cardLabel(card);
            button.append(corner, value, corner.cloneNode(true));
            button.addEventListener("click", () => {
                if (!handHidden) void handlePlay(card);
            });
            container.appendChild(button);
        });

        container.inert = handHidden;
        container.setAttribute("aria-hidden", String(handHidden));
        $("hand-viewport").classList.toggle("is-hidden", handHidden);
        $("hand-cover").hidden = !handHidden;
        $("hand-cover").setAttribute("aria-hidden", String(!handHidden));

        const visibilityButton = action("toggle-hand-visibility");
        visibilityButton.textContent = handHidden ? "Kartları göster" : "Kartları gizle";
        visibilityButton.setAttribute("aria-pressed", String(handHidden));
        visibilityButton.title = handHidden ? "Kart yüzlerini tekrar göster" : "Kart yüzlerini gizle";
    };

    const render = () => {
        if (!matchState) return;

        const stateForRender = matchState;
        const renderVersion = ++profileRenderVersion;

        // Draw game state immediately; profile reads must not block the table or hand.
        renderPlayers();
        renderHand();

        const currentName = playerLabel(stateForRender.currentPlayerUid, members, profiles);
        const isMyTurn = stateForRender.currentPlayerUid === uid && stateForRender.status === "playing";
        $("turn").textContent = isMyTurn ? "SIRA SENDE" : "Sıra: " + currentName;
        $("active-color").textContent = "Aktif renk: " + (COLOR_LABELS[stateForRender.activeColor] || "—");
        $("active-color").className = "uno-active-color is-" + (stateForRender.activeColor || "none");
        $("direction").textContent = "Yön: " + (stateForRender.direction === -1 ? "←" : "→");
        $("draw-count").textContent = (stateForRender.drawPile || []).length;
        $("discard").replaceChildren();

        if (stateForRender.topCard) {
            const top = document.createElement("div");
            top.className = "uno-card uno-card-top uno-card-" + (stateForRender.topCard.color || "wild");
            const topValue = document.createElement("span");
            topValue.className = "uno-card-value";
            topValue.textContent = cardLabel(stateForRender.topCard);
            top.appendChild(topValue);
            $("discard").appendChild(top);
        }

        action("draw").disabled = !isMyTurn || Boolean(stateForRender.drewCardId);
        action("end-turn").hidden = !isMyTurn || !stateForRender.drewCardId;
        action("leave").hidden = stateForRender.status !== "playing" || !stateForRender.activePlayerIds?.includes(uid);
        action("leave").disabled = (stateForRender.activePlayerIds?.length || 0) <= 1;
        action("leave").title = action("leave").disabled
            ? "Son oyuncusun; maç sonucu otomatik tamamlanacak."
            : "Maçı terk et";
        action("uno").hidden = !(stateForRender.unoPendingUid === uid && !stateForRender.unoCalled && stateForRender.status === "playing");
        action("catch").hidden = !(
            stateForRender.activePlayerIds?.includes(uid) &&
            stateForRender.unoPendingUid &&
            !stateForRender.unoCalled &&
            stateForRender.unoPendingUid !== uid
        );
        setStatus(stateForRender.status === "results" ? "Maç tamamlandı" : isMyTurn ? "Hamleni yap" : "Diğer oyuncunun hamlesi bekleniyor");

        if (stateForRender.status === "results") {
            renderResult();
        }

        void loadProfiles(stateForRender.playerIds || []).then(() => {
            if (closed || renderVersion !== profileRenderVersion) return;
            renderPlayers();
            if (matchState?.status === "results") renderResult();
            else if (matchState) {
                const latestName = playerLabel(matchState.currentPlayerUid, members, profiles);
                const latestMyTurn = matchState.currentPlayerUid === uid && matchState.status === "playing";
                $("turn").textContent = latestMyTurn ? "SIRA SENDE" : "Sıra: " + latestName;
            }
        });
    };

    const renderResult = () => {
        const winner = matchState.winnerId;
        $("winner").textContent = winner
            ? playerLabel(winner, members, profiles) + " kazandı!"
            : "Maç tamamlandı";

        const scores = $("result-scores");
        scores.replaceChildren();
        matchState.playerIds.forEach((playerId) => {
            const row = document.createElement("div");
            row.className = "uno-result-row";
            const label = document.createElement("span");
            label.textContent = playerLabel(playerId, members, profiles);
            const count = document.createElement("strong");
            count.textContent = (Number(matchState.handCounts?.[playerId]) || 0) + " kart";
            row.append(label, count);
            scores.appendChild(row);
        });

        $("result").hidden = false;
    };

    const formatPlayError = (error) => {
        const message = error?.message || "Kart oynanamadı.";
        return error?.code ? message + " (" + error.code + ")" : message;
    };

    const handlePlay = async (card) => {
        if (
            cardActionInProgress ||
            handHidden ||
            !matchState ||
            matchState.currentPlayerUid !== uid
        ) return;

        if (card.type === "wild" || card.type === "wild4") {
            selectedWildCardId = card.id;
            $("color-modal").hidden = false;
            return;
        }

        cardActionInProgress = true;
        renderHand();
        try {
            setMessage("Kart oynanıyor…");
            await playCard(db, roomId, round, uid, card.id);
            setMessage("");
        } catch (error) {
            setMessage(formatPlayError(error), true);
        } finally {
            cardActionInProgress = false;
            if (!closed && matchState?.status === "playing") renderHand();
        }
    };

    const close = () => {
        if (closed) return;
        closed = true;
        if (unsubscribeMatch) unsubscribeMatch();
        if (timeoutTimer) clearInterval(timeoutTimer);
        root.remove();
    };

    const returnFromResults = async (button) => {
        if (matchState?.status !== "results" || typeof onReturnToLobby !== "function") {
            close();
            return;
        }

        button.disabled = true;
        try {
            setStatus("Yeni lobi hazırlanıyor…");
            await onReturnToLobby();
            close();
        } catch (error) {
            const errorMessage = error?.message || "Bilinmeyen hata";
            const errorCode = error?.code ? " (" + error.code + ")" : "";
            setMessage("Lobiye dönülemedi: " + errorMessage + errorCode, true);
            button.disabled = false;
        }
    };

    action("toggle-hand-visibility").addEventListener("click", () => {
        handHidden = !handHidden;
        renderHand();
    });

    action("close").addEventListener("click", (event) => {
        if (matchState?.status === "results") {
            void returnFromResults(event.currentTarget);
            return;
        }
        close();
    });
    action("close-result").addEventListener("click", (event) => {
        void returnFromResults(event.currentTarget);
    });
    action("leave").addEventListener("click", async (event) => {
        const button = event.currentTarget;
        if (!window.confirm("Maçı tamamen terk etmek istiyor musun? Oyun lobisinden de çıkarılacaksın. İki kişilik maçta kalan oyuncu kazanır.")) return;

        button.disabled = true;
        try {
            const left = await onLeave?.();
            if (left === false) {
                throw new Error("Maç terk edilemedi. Lobi çıkış mesajını kontrol et.");
            }
            close();
        } catch (error) {
            const code = error?.code ? " (" + error.code + ")" : "";
            setMessage(
                (error?.message || "Maçı terk edemedin.") + code,
                true
            );
            button.disabled = false;
        }
    });

    action("draw").addEventListener("click", async () => {
        try {
            setMessage("Kart çekiliyor…");
            const result = await drawOneCard(db, roomId, round, uid);
            setMessage(result.empty
                ? "Çekme destesi ve yeniden karıştırılabilecek kart kalmadı; sıra sonraki oyuncuya geçti."
                : result.playable
                    ? "Çektiğin kartı oynayabilir veya sıranı bitirebilirsin."
                    : "Çektiğin kart oynanamıyor; sıra sonraki oyuncuya geçti.");
        } catch (error) {
            setMessage(error.message || "Kart çekilemedi.", true);
        }
    });

    action("end-turn").addEventListener("click", async () => {
        try {
            await endTurnAfterDraw(db, roomId, round, uid);
            setMessage("");
        } catch (error) {
            setMessage(error.message || "Sıra bitirilemedi.", true);
        }
    });

    action("uno").addEventListener("click", async () => {
        try {
            await callUno(db, roomId, round, uid);
            setMessage("UNO dedin!");
        } catch (error) {
            setMessage(error.message || "UNO çağrısı yapılamadı.", true);
        }
    });

    action("catch").addEventListener("click", async () => {
        try {
            const result = await catchUno(db, roomId, round, uid);
            setMessage(playerLabel(result.targetUid, members, profiles) + " UNO demedi: " + result.count + " kart çekti.");
        } catch (error) {
            setMessage(error.message || "UNO yakalanamadı.", true);
        }
    });

    root.querySelectorAll("[data-color]").forEach((button) => {
        button.addEventListener("click", async () => {
            if (!selectedWildCardId || cardActionInProgress || handHidden) return;
            const color = button.dataset.color;
            $("color-modal").hidden = true;
            cardActionInProgress = true;
            renderHand();
            try {
                await playCard(db, roomId, round, uid, selectedWildCardId, color);
                setMessage("Aktif renk " + COLOR_LABELS[color] + " oldu.");
            } catch (error) {
                setMessage(formatPlayError(error), true);
            } finally {
                selectedWildCardId = null;
                cardActionInProgress = false;
                if (!closed && matchState?.status === "playing") renderHand();
            }
        });
    });

    const startMatchSubscription = (watchHand) => {
        if (closed || unsubscribeMatch) return;

        unsubscribeMatch = subscribeToMatch(
            db,
            roomId,
            round,
            uid,
            (state) => {
                if (closed) return;
                matchState = state;
                if (!state) {
                    setStatus("Yeni tur hazırlanıyor…");
                    $("players").replaceChildren();
                    $("discard").replaceChildren();
                    $("hand").replaceChildren();
                    $("hand-count").textContent = "0 kart";
                    return;
                }
                render();
            },
            (hand) => {
                if (closed) return;
                handData = hand;
                renderHand();
            },
            (error, source) => setMessage((source ? source + ": " : "") + (error.message || "UNO bağlantısı koptu."), true),
            watchHand
        );
    };

    timeoutTimer = setInterval(() => {
        if (closed || matchState?.status !== "playing" || !matchState.activePlayerIds?.includes(uid)) {
            return;
        }

        const turnStartedAt = matchState.turnStartedAt?.toMillis?.();
        const timeoutKey = String(matchState.turnNumber) + ":" + matchState.currentPlayerUid;
        if (!Number.isFinite(turnStartedAt) || Date.now() - turnStartedAt < 90000) return;
        if (timeoutAttemptedKey === timeoutKey) return;

        timeoutAttemptedKey = timeoutKey;
        skipTimedOutTurn(db, roomId, round, uid)
            .then((skipped) => {
                if (!skipped) timeoutAttemptedKey = null;
            })
            .catch((error) => {
                timeoutAttemptedKey = null;
                if (error.code !== "permission-denied") {
                    setMessage(error.message || "Sıra zaman aşımı denetlenemedi.", true);
                }
            });
    }, 5000);

    const isMatchPlayer = session?.status === "playing" &&
        Array.isArray(session?.matchPlayerIds) &&
        session.matchPlayerIds.includes(uid);

    if (isMatchPlayer) {
        setStatus("Kartlar dağıtılıyor…");
        ensureMatch(db, roomId, round, uid, { recoverStaleSession: true })
            .then((result) => {
                if (closed) return;

                if (result?.sessionAdvanced) {
                    setStatus("Eski maç kaydı temizlendi. Yeni tur başlatılıyor…");
                    close();
                    return;
                }

                // The private hand document must exist before its listener is attached.
                startMatchSubscription(true);
            })
            .catch((error) => {
                if (!closed) setMessage("Kart dağıtımı başarısız: " + (error.message || "Maç hazırlanamadı."), true);
            });
    } else {
        startMatchSubscription(false);
        setMessage("İzleyici görünümü. Kart elleri yalnızca ilgili oyuncuya gösterilir.");
    }

    return { close, isClosed: () => closed };
}
