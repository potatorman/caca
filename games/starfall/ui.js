import { setAvatarElement } from "../../js/avatars.js";
import { connectToMatch } from "./state.js";

const memberOf = (id, members) => members.find((member) => member.id === id) || null;
const playerName = (id, members, myId) => {
    const member = memberOf(id, members);
    const name = member?.displayNickname || member?.username || "Oyuncu";
    return id === myId ? name + " · Sen" : name;
};

const STYLE = `
.starfall-overlay{position:fixed;inset:0;z-index:12000;display:flex;align-items:center;justify-content:center;padding:clamp(8px,2vw,24px);background:rgba(5,10,28,.82);backdrop-filter:blur(14px);color:#f4f6ff;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
.starfall-shell{width:min(1120px,100%);max-height:min(94dvh,980px);overflow:auto;border:1px solid rgba(151,173,255,.23);border-radius:26px;background:radial-gradient(900px 460px at 50% -20%,rgba(83,105,211,.28),transparent 68%),linear-gradient(145deg,#121a3b,#0a1029 65%,#0c1832);box-shadow:0 34px 100px rgba(0,0,0,.48)}
.starfall-header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:22px 26px;border-bottom:1px solid rgba(151,173,255,.14)}
.starfall-brand{display:flex;align-items:center;gap:14px}.starfall-mark{width:48px;height:48px;border-radius:16px;display:grid;place-items:center;font-size:24px;background:linear-gradient(145deg,#a18bff,#5b69d9);box-shadow:0 8px 28px rgba(100,104,234,.35)}
.starfall-eyebrow{display:block;font-size:10px;letter-spacing:.2em;font-weight:800;color:#a8b5ef}.starfall-header h2{margin:3px 0 0;font-size:clamp(21px,3vw,28px);letter-spacing:-.04em}.starfall-header p{margin:4px 0 0;font-size:12px;color:#a9b4d8}
.starfall-header-actions{display:flex;align-items:center;gap:10px}.starfall-connection{display:flex;align-items:center;gap:7px;padding:8px 11px;border-radius:99px;background:rgba(255,255,255,.06);font-size:11px;color:#cbd4f5}.starfall-connection:before{content:"";width:7px;height:7px;border-radius:50%;background:#f5b85e}.starfall-connection.is-connected:before{background:#5ce0ad;box-shadow:0 0 10px #5ce0ad}.starfall-close{border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.07);color:#fff;border-radius:12px;width:38px;height:38px;font-size:23px;cursor:pointer}
.starfall-layout{display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:18px;padding:20px 22px 24px}.starfall-main{min-width:0}.starfall-turnbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;margin-bottom:14px;border:1px solid rgba(151,173,255,.16);border-radius:16px;background:rgba(255,255,255,.045)}
.starfall-turn-label{font-size:11px;color:#aeb9de;letter-spacing:.08em;text-transform:uppercase}.starfall-turn-value{font-size:15px;font-weight:800;color:#fff;margin-top:3px}.starfall-turn-meta{text-align:right;font-size:12px;color:#b9c4e8}.starfall-turn-meta strong{display:block;color:#fff;font-size:17px}
.starfall-board-wrap{position:relative;padding:clamp(8px,1.5vw,14px);border:1px solid rgba(151,173,255,.17);border-radius:20px;background:linear-gradient(145deg,rgba(68,86,160,.22),rgba(12,21,53,.66));box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}
.starfall-board{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:clamp(5px,1vw,10px);max-width:690px;margin:auto}
.starfall-cell{position:relative;aspect-ratio:1;border:1px solid rgba(160,181,255,.18);border-radius:clamp(8px,1.5vw,14px);background:linear-gradient(145deg,#273665,#1b2850);color:#fff;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;transition:transform .16s ease,border-color .16s ease,background .16s ease;min-width:0;padding:3px}
.starfall-cell:not(:disabled):hover{transform:translateY(-3px);border-color:#b6a4ff;background:linear-gradient(145deg,#384b86,#29396a);box-shadow:0 8px 20px rgba(89,101,207,.22)}
.starfall-cell:disabled{cursor:default;opacity:1}.starfall-cell.is-available{border-color:rgba(156,174,255,.3)}.starfall-cell.is-mine{background:linear-gradient(145deg,#6655b2,#443a85);border-color:#b4a5ff}.starfall-cell.is-opponent{background:linear-gradient(145deg,#285b68,#1c4257);border-color:rgba(116,224,216,.38)}.starfall-cell.is-star:after{content:"✦";position:absolute;top:5px;right:7px;font-size:11px;color:#ffd77c}.starfall-cell-value{font-size:clamp(16px,3vw,25px);font-weight:900;line-height:1}.starfall-cell-hint{font-size:clamp(8px,1.2vw,10px);color:#cad3fa}.starfall-cell-owner{font-size:10px;font-weight:800;letter-spacing:.06em;color:#fff}
.starfall-legend{display:flex;justify-content:center;flex-wrap:wrap;gap:14px;padding:12px 4px 2px;color:#aeb9de;font-size:10px}.starfall-legend span{display:flex;align-items:center;gap:6px}.starfall-dot{width:8px;height:8px;border-radius:3px;background:#a18bff}.starfall-dot.opponent{background:#55c7c3}.starfall-dot.star{background:#ffd77c}
.starfall-sidebar{display:flex;flex-direction:column;gap:12px}.starfall-panel{border:1px solid rgba(151,173,255,.15);border-radius:17px;background:rgba(255,255,255,.045);padding:14px}.starfall-panel h3{margin:0 0 11px;font-size:12px;letter-spacing:.11em;text-transform:uppercase;color:#aeb9de}
.starfall-player{display:grid;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:9px;padding:9px 0;border-top:1px solid rgba(151,173,255,.1)}.starfall-player:first-of-type{border-top:0}.starfall-player.is-current{background:rgba(143,129,255,.11);margin:0 -7px;padding:9px 7px;border-radius:10px}.starfall-avatar{width:32px;height:32px;border-radius:11px;overflow:hidden;background:#38456f;display:grid;place-items:center}.starfall-player-info{min-width:0}.starfall-player-info strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.starfall-player-info small{display:block;font-size:10px;color:#9eabd4;margin-top:3px}.starfall-score{text-align:right;font-size:14px;font-weight:900;color:#fff}.starfall-score small{display:block;font-size:9px;font-weight:500;color:#9eabd4}
.starfall-rules{font-size:11px;line-height:1.6;color:#bdc7e8}.starfall-rules strong{color:#fff}.starfall-rules p{margin:0 0 8px}.starfall-rules p:last-child{margin-bottom:0}.starfall-message{min-height:22px;padding:8px 4px 0;text-align:center;font-size:12px;color:#b8c6f3}.starfall-message.is-error{color:#ff9d9d}
.starfall-result{position:fixed;inset:0;z-index:2;display:grid;place-items:center;padding:20px;background:rgba(5,8,25,.8);backdrop-filter:blur(8px)}.starfall-result[hidden]{display:none}.starfall-result-card{width:min(430px,100%);padding:26px;border-radius:22px;border:1px solid rgba(183,171,255,.35);background:linear-gradient(145deg,#202b59,#101a3c);box-shadow:0 24px 80px rgba(0,0,0,.48);text-align:center}.starfall-result-icon{font-size:34px}.starfall-result-card h3{font-size:24px;margin:8px 0 5px}.starfall-result-card p{font-size:12px;line-height:1.5;color:#b6c3e8}.starfall-result-scores{display:grid;gap:7px;margin:18px 0;text-align:left}.starfall-result-row{display:flex;justify-content:space-between;padding:9px 11px;border-radius:10px;background:rgba(255,255,255,.06);font-size:12px}.starfall-primary{width:100%;border:0;border-radius:12px;padding:12px 16px;background:linear-gradient(100deg,#9580ff,#6478e7);color:white;font-weight:800;cursor:pointer}.starfall-primary:disabled{opacity:.5;cursor:wait}
@media(max-width:760px){.starfall-layout{grid-template-columns:minmax(0,1fr);padding:13px}.starfall-sidebar{display:grid;grid-template-columns:1fr 1fr}.starfall-header{padding:16px}.starfall-header-actions{gap:6px}.starfall-connection{max-width:126px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.starfall-board-wrap{padding:8px}.starfall-cell{border-radius:8px}.starfall-panel{padding:11px}}
@media(max-width:420px){.starfall-overlay{padding:0;align-items:stretch}.starfall-shell{max-height:100dvh;border-radius:0;border-left:0;border-right:0}.starfall-header{padding:13px}.starfall-mark{width:40px;height:40px}.starfall-layout{gap:10px;padding:10px}.starfall-sidebar{grid-template-columns:1fr}.starfall-panel{padding:10px}.starfall-player{padding:7px 0}.starfall-turnbar{padding:10px 12px}.starfall-board{gap:4px}.starfall-cell{border-radius:7px}.starfall-cell-value{font-size:18px}.starfall-cell-hint{font-size:8px}}
`;

export async function openStarfallGame({
    db, roomId, round, uid, session, roomMembers = [], onLeave, onReturnToLobby
}) {
    const members = Array.isArray(roomMembers) ? roomMembers : [];
    const root = document.createElement("section");
    root.className = "starfall-overlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Starfall Grid oyun masası");
    root.innerHTML = `
        <style>${STYLE}</style>
        <div class="starfall-shell">
            <header class="starfall-header">
                <div class="starfall-brand">
                    <span class="starfall-mark" aria-hidden="true">✦</span>
                    <div>
                        <span class="starfall-eyebrow">RENDECHAT · STRATEJİ OYUNU</span>
                        <h2>Starfall Grid</h2>
                        <p data-role="status">Oyun masası hazırlanıyor…</p>
                    </div>
                </div>
                <div class="starfall-header-actions">
                    <span class="starfall-connection" data-role="connection">Bağlanıyor</span>
                    <button class="starfall-close" type="button" data-action="close" aria-label="Oyundan ayrıl">×</button>
                </div>
            </header>
            <div class="starfall-layout">
                <main class="starfall-main">
                    <div class="starfall-turnbar">
                        <div>
                            <div class="starfall-turn-label">Sıra</div>
                            <div class="starfall-turn-value" data-role="turn">Sunucu bekleniyor…</div>
                        </div>
                        <div class="starfall-turn-meta"><strong data-role="turn-number">—</strong><span>hamle</span></div>
                    </div>
                    <div class="starfall-board-wrap">
                        <div class="starfall-board" data-role="board" aria-label="6'ya 6 oyun tahtası"></div>
                        <div class="starfall-legend">
                            <span><i class="starfall-dot"></i> Senin karelerin</span>
                            <span><i class="starfall-dot opponent"></i> Rakip kareleri</span>
                            <span><i class="starfall-dot star"></i> Yıldız +3</span>
                        </div>
                    </div>
                    <p class="starfall-message" data-role="message" aria-live="polite"></p>
                </main>
                <aside class="starfall-sidebar">
                    <section class="starfall-panel">
                        <h3>Skor tablosu</h3>
                        <div data-role="players"></div>
                    </section>
                    <section class="starfall-panel">
                        <h3>Nasıl oynanır?</h3>
                        <div class="starfall-rules">
                            <p><strong>1.</strong> Sıran geldiğinde boş bir kare seç. Her oyuncunun 4 hamlesi var.</p>
                            <p><strong>2.</strong> Karede yazan sayı puanındır. Yıldızlı kareler <strong>+3</strong> verir.</p>
                            <p><strong>3.</strong> Kendi karelerine komşu seçimler bağlantı başına <strong>+2</strong> kazandırır (en fazla +4).</p>
                            <p><strong>4.</strong> Tüm hamleler bitince en yüksek skoru toplayan kazanır. Beraberlik mümkündür.</p>
                            <p><strong>Tur süresi:</strong> 60 saniye. Süre biterse hamlen otomatik geçilir.</p>
                        </div>
                    </section>
                </aside>
            </div>
            <div class="starfall-result" data-role="result" hidden>
                <div class="starfall-result-card">
                    <div class="starfall-result-icon">🏆</div>
                    <span class="starfall-eyebrow">MAÇ SONUCU</span>
                    <h3 data-role="winner">Skor hesaplanıyor…</h3>
                    <p data-role="result-hint">Tüm oyuncular lobiye döndüğünde yeni bir maç başlatabilirsiniz.</p>
                    <div class="starfall-result-scores" data-role="result-scores"></div>
                    <button class="starfall-primary" type="button" data-action="return">Lobiye dön</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(root);

    const role = (name) => root.querySelector('[data-role="' + name + '"]');
    const action = (name) => root.querySelector('[data-action="' + name + '"]');
    const initialPlayers = Array.isArray(session?.matchPlayerIds) ? session.matchPlayerIds : [];
    const isMatchPlayer = ["playing", "results"].includes(session?.status) && initialPlayers.includes(uid);
    let state = null;
    let connection = null;
    let connected = false;
    let busy = false;
    let closed = false;
    let messageTimer = null;
    let lastMoveKey = "";

    function showMessage(message, isError = false) {
        const target = role("message");
        target.textContent = message || "";
        target.classList.toggle("is-error", Boolean(isError));
        if (messageTimer) clearTimeout(messageTimer);
        if (message) messageTimer = setTimeout(() => {
            target.textContent = "";
            target.classList.remove("is-error");
            messageTimer = null;
        }, 5000);
    }

    function renderPlayers() {
        const container = role("players");
        container.replaceChildren();
        if (!state) return;
        state.playerIds.forEach((id) => {
            const member = memberOf(id, members);
            const row = document.createElement("div");
            row.className = "starfall-player" +
                (state.currentPlayerUid === id ? " is-current" : "");
            const avatar = document.createElement("span");
            avatar.className = "starfall-avatar";
            setAvatarElement(avatar, member?.avatarId, member?.avatarData);
            const info = document.createElement("span");
            info.className = "starfall-player-info";
            const name = document.createElement("strong");
            name.textContent = playerName(id, members, uid);
            const detail = document.createElement("small");
            const online = state.onlineIds?.includes(id);
            const remaining = Number(state.turnsRemainingByPlayer?.[id]) || 0;
            detail.textContent = !state.activePlayerIds.includes(id)
                ? "Maçtan ayrıldı"
                : (online ? "Çevrimiçi" : "Yeniden bağlanabilir") + " · " + remaining + " hamle";
            info.append(name, detail);
            const score = document.createElement("strong");
            score.className = "starfall-score";
            score.textContent = String(Number(state.scores?.[id]) || 0);
            const scoreLabel = document.createElement("small");
            scoreLabel.textContent = "PUAN";
            score.appendChild(scoreLabel);
            row.append(avatar, info, score);
            container.appendChild(row);
        });
    }

    function buildBoard() {
        const board = role("board");
        board.replaceChildren();
        for (let index = 0; index < 36; index += 1) {
            const tile = document.createElement("button");
            tile.type = "button";
            tile.className = "starfall-cell";
            tile.dataset.index = String(index);
            tile.setAttribute("aria-label", "Kare " + (index + 1));
            tile.addEventListener("click", () => void claimCell(index));
            board.appendChild(tile);
        }
    }

    function renderBoard() {
        const cells = Array.isArray(state?.board) ? state.board : [];
        [...role("board").children].forEach((tile, index) => {
            const cell = cells[index];
            if (!cell) return;
            tile.replaceChildren();
            const owner = cell.ownerId;
            const mine = owner === uid;
            const member = owner ? memberOf(owner, members) : null;
            tile.className = "starfall-cell" +
                (owner ? (mine ? " is-mine" : " is-opponent") : " is-available") +
                (cell.bonus ? " is-star" : "");
            const value = document.createElement("span");
            value.className = "starfall-cell-value";
            value.textContent = String(cell.value);
            const hint = document.createElement("small");
            hint.className = "starfall-cell-hint";
            hint.textContent = owner ? "+" + (Number(cell.awardedPoints) || 0) + " puan" : "BOŞ KARE";
            tile.append(value, hint);
            if (owner) {
                const marker = document.createElement("span");
                marker.className = "starfall-cell-owner";
                marker.textContent = owner === uid
                    ? "SEN"
                    : (member?.displayNickname || member?.username || "OYUNCU").slice(0, 9).toUpperCase();
                tile.appendChild(marker);
            } else if (cell.bonus) {
                hint.textContent = "YILDIZ +3";
            }
            const myTurn = state.status === "playing" && state.currentPlayerUid === uid;
            tile.disabled = Boolean(owner) || !myTurn || !connected || busy;
            tile.setAttribute("aria-label",
                "Kare " + (index + 1) + ", değer " + cell.value +
                (cell.bonus ? ", yıldız bonusu" : "") +
                (owner ? ", dolu" : ", boş")
            );
        });
    }

    function renderResult() {
        if (!state || state.status !== "results") {
            role("result").hidden = true;
            return;
        }
        const winners = Array.isArray(state.winnerIds) ? state.winnerIds : [];
        const title = winners.length > 1
            ? "Beraberlik!"
            : winners.length === 1
                ? playerName(winners[0], members, uid) + " kazandı!"
                : "Maç tamamlandı";
        role("winner").textContent = title;
        role("result-hint").textContent = winners.includes(uid)
            ? "Harika oyun! Diğer oyuncular da lobiye döndüğünde rövanş başlatabilirsiniz."
            : "Rövanş için lobiye dön. Herkes hazır olduğunda yeni maç başlayabilir.";
        const scores = role("result-scores");
        scores.replaceChildren();
        const ordered = [...state.playerIds].sort((a, b) =>
            (Number(state.scores?.[b]) || 0) - (Number(state.scores?.[a]) || 0)
        );
        ordered.forEach((id) => {
            const row = document.createElement("div");
            row.className = "starfall-result-row";
            const name = document.createElement("span");
            name.textContent = playerName(id, members, uid);
            const value = document.createElement("strong");
            value.textContent = (Number(state.scores?.[id]) || 0) + " puan";
            row.append(name, value);
            scores.appendChild(row);
        });
        action("return").disabled = busy || !isMatchPlayer;
        action("return").hidden = !isMatchPlayer;
        role("result").hidden = false;
    }

    function render() {
        if (!state) return;
        const myTurn = state.status === "playing" && state.currentPlayerUid === uid;
        const currentName = state.currentPlayerUid
            ? playerName(state.currentPlayerUid, members, uid)
            : "Maç tamamlandı";
        role("status").textContent = state.status === "results"
            ? "Maç tamamlandı · " + state.turnNumber + " hamle"
            : "Tahtada 36 yıldız karesi · 60 saniyelik hamle süresi";
        role("turn").textContent = myTurn ? "Sıra sende — bir kare seç!" : "Sıra: " + currentName;
        role("turn-number").textContent = state.turnNumber + " / " + state.maxTurns;
        renderPlayers();
        renderBoard();
        renderResult();
        if (state.lastMove) {
            const key = state.lastMove.turnNumber + ":" + state.lastMove.uid + ":" + state.lastMove.cellIndex;
            if (key !== lastMoveKey) {
                lastMoveKey = key;
                const name = playerName(state.lastMove.uid, members, uid);
                if (state.lastMove.skipped) showMessage(name + " süresi dolduğu için hamlesini geçti.");
                else showMessage(name + " kare " + (state.lastMove.cellIndex + 1) + " aldı · +" + state.lastMove.totalPoints + " puan");
            }
        }
        action("close").textContent = state.status === "playing" && isMatchPlayer ? "×" : "×";
    }

    async function claimCell(index) {
        if (busy || closed || !connection || !state || state.currentPlayerUid !== uid) return;
        busy = true;
        renderBoard();
        try {
            const result = await connection.request("claim", { cellIndex: index });
            showMessage("Kare alındı: +" + result.totalPoints + " puan.");
        } catch (error) {
            showMessage(error.message || "Hamle yapılamadı.", true);
        } finally {
            busy = false;
            render();
        }
    }

    function disposeView() {
        if (closed) return;
        closed = true;
        if (messageTimer) clearTimeout(messageTimer);
        connection?.close();
        root.remove();
    }

    async function returnToLobby() {
        if (busy || closed || !onReturnToLobby) return;
        busy = true;
        action("return").disabled = true;
        try {
            await onReturnToLobby();
            disposeView();
        } catch (error) {
            showMessage(error.message || "Lobiye dönülemedi.", true);
            busy = false;
            action("return").disabled = false;
        }
    }

    async function closeView() {
        if (closed) return;
        if (state?.status === "playing" && isMatchPlayer && onLeave) {
            if (busy) return;
            busy = true;
            action("close").disabled = true;
            try {
                const left = await onLeave();
                if (!left) {
                    busy = false;
                    action("close").disabled = false;
                    showMessage("Maçtan ayrılamadın. Tekrar dene.", true);
                    return;
                }
            } catch (error) {
                busy = false;
                action("close").disabled = false;
                showMessage(error.message || "Maçtan ayrılamadın.", true);
                return;
            }
        } else if (state?.status === "results" && isMatchPlayer && onReturnToLobby) {
            await returnToLobby();
            return;
        }
        disposeView();
    }

    action("close").addEventListener("click", () => void closeView());
    action("return").addEventListener("click", () => void returnToLobby());
    buildBoard();

    try {
        connection = await connectToMatch(db, roomId, session.lobbyId, round, uid, {
            onState(nextState) {
                if (closed || !nextState) return;
                state = nextState;
                render();
            },
            onConnectionState(isConnected, message) {
                connected = isConnected;
                const indicator = role("connection");
                indicator.textContent = message || (isConnected ? "Bağlı" : "Bağlanıyor");
                indicator.classList.toggle("is-connected", isConnected);
                renderBoard();
            },
            onError(error) {
                showMessage(error.message || "Bağlantı sorunu yaşandı.", true);
            }
        });
    } catch (error) {
        showMessage(error.message || "Starfall bağlantısı kurulamadı.", true);
        role("status").textContent = "Sunucu bağlantısı bekleniyor…";
    }

    return {
        close() {
            if (closed) return;
            closed = true;
            if (messageTimer) clearTimeout(messageTimer);
            connection?.close();
            root.remove();
        },
        isClosed() {
            return closed;
        }
    };
}
