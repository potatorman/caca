import { setAvatarElement } from "../../js/avatars.js";
import { isCardPlayable } from "./engine.js";
import { connectToMatch } from "./state.js";

const COLORS = Object.freeze({
    red: "Kırmızı",
    yellow: "Sarı",
    green: "Yeşil",
    blue: "Mavi"
});
const CARD_NAMES = Object.freeze({
    skip: "PAS",
    reverse: "YÖN",
    draw2: "+2",
    wild: "RENK",
    wild4: "+4"
});

const labelCard = (card) => CARD_NAMES[card?.type] || String(card?.value ?? "");
const memberOf = (id, members) => members.find((member) => member.id === id) || null;
const labelPlayer = (id, members, myId) => {
    const member = memberOf(id, members);
    const name = member?.displayNickname || member?.username || "Oyuncu";
    return id === myId ? name + " · Sen" : name;
};
const errorMessage = (error, fallback) => {
    const message = error?.message || fallback;
    return error?.code ? message + " (" + error.code + ")" : message;
};

export async function openUnoGame({
    db, roomId, round, uid, session, roomMembers = [], onLeave, onReturnToLobby
}) {
    const members = Array.isArray(roomMembers) ? roomMembers : [];
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
                    <button type="button" class="uno-close" data-action="close"
                        aria-label="Maçı terk et" title="Maçı terk et">×</button>
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
                                data-action="toggle-hand-visibility" aria-pressed="false">Kartları gizle</button>
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
                    <p class="uno-result-hint">Bu ekran 5 saniye sonra otomatik kapanır ve lobiye dönersin. Daha erken dönmek için aşağıdaki butona bas.</p>
                    <p class="uno-message uno-result-message" data-role="result-message" aria-live="assertive"></p>
                    <button class="uno-primary" type="button" data-action="close-result">Lobiye dön</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(root);

    const role = (name) => root.querySelector('[data-role="' + name + '"]');
    const action = (name) => root.querySelector('[data-action="' + name + '"]');
    const isMatchPlayer = session?.status === "playing" &&
        Array.isArray(session?.matchPlayerIds) &&
        session.matchPlayerIds.includes(uid);

    let state = null;
    let hand = null;
    let selectedWildCard = null;
    let connection = null;
    let hiddenHand = false;
    let busy = false;
    let closed = false;
    let resultAutoCloseTimer = null;
    let resultAutoCloseScheduled = false;

    role("hand-area").hidden = !isMatchPlayer;
    action("close").setAttribute("aria-label", isMatchPlayer ? "Maçı terk et" : "Oyunu kapat");
    action("close").title = isMatchPlayer ? "Maçı terk et" : "Oyunu kapat";

    function setStatus(message) {
        role("status").textContent = message || "";
    }

    function setMessage(message = "", isError = false) {
        const target = role("result").hidden ? role("message") : role("result-message");
        target.textContent = message;
        target.classList.toggle("is-error", Boolean(isError));
    }

    function renderPlayers() {
        const container = role("players");
        container.replaceChildren();
        if (!state) return;

        const players = Array.isArray(state.playerIds) ? state.playerIds : state.activePlayerIds || [];
        players.forEach((id) => {
            const member = memberOf(id, members);
            const active = state.activePlayerIds?.includes(id);
            const current = state.currentPlayerUid === id;
            const row = document.createElement("article");
            row.className = "uno-player" +
                (current ? " is-current" : "") +
                (!active ? " is-left" : "");

            const avatar = document.createElement("span");
            avatar.className = "uno-avatar";
            setAvatarElement(avatar, member?.avatarId, member?.avatarData);

            const details = document.createElement("span");
            details.className = "uno-player-details";
            const name = document.createElement("strong");
            name.textContent = labelPlayer(id, members, uid);
            const count = document.createElement("small");
            count.textContent = active
                ? (Number(state.handCounts?.[id]) || 0) + " kart"
                : "Maçtan ayrıldı";
            details.append(name, count);

            const turn = document.createElement("span");
            turn.className = "uno-player-turn";
            turn.textContent = current ? "SIRA" : "";
            row.append(avatar, details, turn);
            container.appendChild(row);
        });
    }

    function renderHand() {
        const container = role("hand");
        container.replaceChildren();
        const cards = Array.isArray(hand?.cards) ? hand.cards : [];
        role("hand-count").textContent = cards.length + " kart";

        cards.forEach((card, index) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "uno-card uno-card-" + (card.color || "wild");
            button.dataset.cardId = card.id;
            button.style.setProperty("--card-index", String(index));

            const myTurn = state?.status === "playing" && state.currentPlayerUid === uid;
            const playable = Boolean(
                myTurn &&
                isCardPlayable(card, state.topCard, state.activeColor, cards) &&
                (!state.drewCardId || state.drewCardId === card.id)
            );
            button.disabled = !playable || hiddenHand || busy;
            button.classList.toggle("is-playable", playable);

            const value = document.createElement("span");
            value.className = "uno-card-value";
            value.textContent = labelCard(card);
            const corner = document.createElement("small");
            corner.textContent = labelCard(card);
            button.append(corner, value, corner.cloneNode(true));
            button.addEventListener("click", () => void playFromHand(card));
            container.appendChild(button);
        });

        container.inert = hiddenHand;
        container.setAttribute("aria-hidden", String(hiddenHand));
        role("hand-viewport").classList.toggle("is-hidden", hiddenHand);
        role("hand-cover").hidden = !hiddenHand;
        role("hand-cover").setAttribute("aria-hidden", String(!hiddenHand));

        action("toggle-hand-visibility").textContent =
            hiddenHand ? "Kartları göster" : "Kartları gizle";
        action("toggle-hand-visibility").setAttribute("aria-pressed", String(hiddenHand));
        action("toggle-hand-visibility").title =
            hiddenHand ? "Kart yüzlerini tekrar göster" : "Kart yüzlerini gizle";
    }

    function renderResult() {
        const winnerId = state?.winnerId;
        role("winner").textContent = winnerId
            ? labelPlayer(winnerId, members, uid) + " kazandı!"
            : "Maç tamamlandı";

        const scores = role("result-scores");
        scores.replaceChildren();
        const players = Array.isArray(state.playerIds) ? state.playerIds : state.activePlayerIds || [];
        players.forEach((id) => {
            const row = document.createElement("div");
            row.className = "uno-result-row";
            const name = document.createElement("span");
            name.textContent = labelPlayer(id, members, uid);
            const count = document.createElement("strong");
            count.textContent = (Number(state.handCounts?.[id]) || 0) + " kart";
            row.append(name, count);
            scores.appendChild(row);
        });
        role("result").hidden = false;
    }

    function render() {
        if (!state) return;
        renderPlayers();
        renderHand();

        const playing = state.status === "playing";
        const myTurn = playing && state.currentPlayerUid === uid;
        role("turn").textContent = myTurn
            ? "SIRA SENDE"
            : "Sıra: " + labelPlayer(state.currentPlayerUid, members, uid);
        role("active-color").textContent = "Aktif renk: " + (COLORS[state.activeColor] || "—");
        role("active-color").className = "uno-active-color is-" + (state.activeColor || "none");
        role("direction").textContent = "Yön: " + (state.direction === -1 ? "←" : "→");
        role("draw-count").textContent = String(
            Number.isFinite(state.drawCount)
                ? state.drawCount
                : Array.isArray(state.drawPile) ? state.drawPile.length : 0
        );

        const discard = role("discard");
        discard.replaceChildren();
        if (state.topCard) {
            const top = document.createElement("div");
            top.className = "uno-card uno-card-top uno-card-" + (state.topCard.color || "wild");
            const value = document.createElement("span");
            value.className = "uno-card-value";
            value.textContent = labelCard(state.topCard);
            top.appendChild(value);
            discard.appendChild(top);
        }

        action("draw").disabled = !myTurn || Boolean(state.drewCardId) || busy;
        action("end-turn").hidden = !myTurn || !state.drewCardId;
        action("end-turn").disabled = busy;

        const canLeave = playing && state.activePlayerIds?.includes(uid);
        const closeButton = action("close");
        closeButton.disabled = busy;
        closeButton.setAttribute(
            "aria-label",
            state.status === "results" ? "Lobiye dön" : canLeave ? "Maçı terk et" : "Oyunu kapat"
        );
        closeButton.title = state.status === "results"
            ? "Lobiye dön"
            : canLeave ? "Maçı terk et" : "Oyunu kapat";

        action("uno").hidden = !(
            playing && state.unoPendingUid === uid && !state.unoCalled
        );
        action("uno").disabled = busy;
        action("catch").hidden = !(
            playing &&
            state.activePlayerIds?.includes(uid) &&
            state.unoPendingUid &&
            !state.unoCalled &&
            state.unoPendingUid !== uid
        );
        action("catch").disabled = busy;

        setStatus(state.status === "results"
            ? "Maç tamamlandı"
            : myTurn ? "Hamleni yap" : "Diğer oyuncunun hamlesi bekleniyor");

        if (state.status === "results") {
            renderResult();
            if (!resultAutoCloseScheduled) {
                resultAutoCloseScheduled = true;
                resultAutoCloseTimer = setTimeout(autoReturnFromResults, 5000);
            }
        } else {
            if (resultAutoCloseTimer !== null) {
                clearTimeout(resultAutoCloseTimer);
                resultAutoCloseTimer = null;
            }
            resultAutoCloseScheduled = false;
            role("result").hidden = true;
        }
    }

    async function perform(task, successText = "") {
        if (busy || closed) return null;
        busy = true;
        renderHand();
        try {
            const result = await task();
            setMessage(successText);
            return result;
        } catch (error) {
            setMessage(errorMessage(error, "İşlem tamamlanamadı."), true);
            return null;
        } finally {
            busy = false;
            if (!closed) render();
        }
    }

    async function playFromHand(card) {
        if (
            busy || hiddenHand || state?.status !== "playing" ||
            state.currentPlayerUid !== uid
        ) return;

        if (card.type === "wild" || card.type === "wild4") {
            selectedWildCard = card.id;
            role("color-modal").hidden = false;
            return;
        }
        await perform(() => connection.request("playCard", { cardId: card.id }));
    }

    function close() {
        if (closed) return;
        closed = true;
        if (resultAutoCloseTimer !== null) {
            clearTimeout(resultAutoCloseTimer);
            resultAutoCloseTimer = null;
        }
        connection?.close();
        root.remove();
    }

    function autoReturnFromResults() {
        resultAutoCloseTimer = null;
        if (closed || state?.status !== "results") return;
        if (busy) {
            resultAutoCloseTimer = setTimeout(autoReturnFromResults, 250);
            return;
        }
        void returnFromResults(action("close-result"));
    }

    async function returnFromResults(button) {
        if (state?.status !== "results" || typeof onReturnToLobby !== "function") {
            close();
            return;
        }
        if (busy) return;
        busy = true;
        button.disabled = true;
        try {
            setStatus("Lobiye dönüşün kaydediliyor…");
            const result = await onReturnToLobby();
            setStatus(result?.completed
                ? "Tüm oyuncular döndü. Yeni lobi açıldı."
                : "Lobiye döndün. Diğer oyuncular bekleniyor (" +
                    (result?.returnedCount ?? 1) + "/" +
                    (result?.requiredCount ?? "…") + ").");
            close();
        } catch (error) {
            setMessage(errorMessage(error, "Lobiye dönülemedi."), true);
            busy = false;
            button.disabled = false;
        }
    }

    action("toggle-hand-visibility").addEventListener("click", () => {
        hiddenHand = !hiddenHand;
        renderHand();
    });
    action("close").addEventListener("click", async (event) => {
        const button = event.currentTarget;
        if (busy || closed) return;

        if (state?.status === "results") {
            await returnFromResults(button);
            return;
        }

        // Use the × button as the single exit action. A current match player
        // forfeits the match; spectators can simply close their table view.
        const activeMatchPlayer = state?.status === "playing"
            ? Boolean(state.activePlayerIds?.includes(uid))
            : isMatchPlayer;
        if (!activeMatchPlayer) {
            close();
            return;
        }

        if (!window.confirm(
            "Maçı tamamen terk etmek istiyor musun? Oyun lobisinden de çıkarılacaksın. İki kişilik maçta kalan oyuncu kazanır."
        )) return;

        busy = true;
        button.disabled = true;
        renderHand();
        try {
            if (typeof onLeave !== "function") {
                throw new Error("Maçtan çıkış işlemi kullanılamıyor.");
            }
            const result = await onLeave();
            if (result === false) throw new Error("Maçtan çıkış tamamlanmadı.");
            close();
        } catch (error) {
            setMessage(errorMessage(error, "Maçı terk edemedin."), true);
            busy = false;
            if (!closed) {
                button.disabled = false;
                render();
            }
        }
    });
    action("close-result").addEventListener("click", (event) => {
        void returnFromResults(event.currentTarget);
    });

    action("draw").addEventListener("click", () => {
        void perform(async () => {
            const result = await connection.request("drawCard");
            return result.empty
                ? "Çekme destesi ve yeniden karıştırılabilecek kart kalmadı; sıra sonraki oyuncuya geçti."
                : result.playable
                    ? "Çektiğin kartı oynayabilir veya sıranı bitirebilirsin."
                    : "Çektiğin kart oynanamıyor; sıra sonraki oyuncuya geçti.";
        }).then((message) => {
            if (typeof message === "string") setMessage(message);
        });
    });
    action("end-turn").addEventListener("click", () => {
        void perform(() => connection.request("endTurn"));
    });
    action("uno").addEventListener("click", () => {
        void perform(() => connection.request("callUno"), "UNO dedin!");
    });
    action("catch").addEventListener("click", () => {
        void perform(async () => {
            const result = await connection.request("catchUno");
            return labelPlayer(result.targetUid, members, uid) +
                " UNO demedi: " + result.count + " kart çekti.";
        }).then((message) => {
            if (typeof message === "string") setMessage(message);
        });
    });

    root.querySelectorAll("[data-color]").forEach((button) => {
        button.addEventListener("click", () => {
            if (!selectedWildCard || busy || hiddenHand) return;
            const cardId = selectedWildCard;
            const color = button.dataset.color;
            selectedWildCard = null;
            role("color-modal").hidden = true;
            void perform(
                () => connection.request("playCard", { cardId, selectedColor: color }),
                "Aktif renk " + COLORS[color] + " oldu."
            );
        });
    });

    setStatus("Cloudflare UNO sunucusuna bağlanılıyor…");
    connectToMatch(db, roomId, round, uid, {
        onState(nextState) {
            if (closed) return;
            state = nextState;
            if (!state) {
                setStatus("Maç hazırlanıyor…");
                return;
            }
            render();
        },
        onHand(nextHand) {
            if (closed) return;
            hand = nextHand;
            renderHand();
        },
        onConnectionState(connected, message) {
            if (closed) return;
            if (!connected) {
                setStatus(message || "UNO sunucusuna bağlanılıyor…");
            } else if (!state) {
                setStatus("UNO sunucusuna bağlandı. Maç verisi bekleniyor…");
            }
        },
        onError(error, source) {
            if (!closed) {
                setMessage(
                    (source ? source + ": " : "") +
                    errorMessage(error, "UNO bağlantısı kurulamadı."),
                    true
                );
            }
        }
    }).then((nextConnection) => {
        if (closed) nextConnection.close();
        else connection = nextConnection;
    }).catch((error) => {
        if (!closed) setMessage(errorMessage(error, "UNO sunucusuna bağlanılamadı."), true);
    });

    if (!isMatchPlayer) {
        setMessage("İzleyici görünümü. Kart elleri yalnızca ilgili oyuncuya gösterilir.");
    }

    return { close, isClosed: () => closed };
}
