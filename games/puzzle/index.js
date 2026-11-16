import {
    connectToPuzzleGame,
    returnToLobby as returnPuzzleToLobby
} from "./state.js";

const memberFor = (uid, members) => members.find((member) => member.id === uid) || null;
const nameFor = (uid, members, myUid) => {
    const member = memberFor(uid, members);
    const name = member?.displayNickname || member?.nickname || member?.username || "Oyuncu";
    return uid === myUid ? name + " · Sen" : name;
};
const gameTitles = {
    "odd-signal": "Odd Signal",
    "pattern-party": "Pattern Party"
};
const gameSubtitles = {
    "odd-signal": "Fazlalığı yakala. Sinyali herkesten önce çöz.",
    "pattern-party": "Diziyi oku. Bir sonraki sayıyı herkesten önce bul."
};

export async function openPuzzleGame({
    roomId,
    round,
    uid,
    session,
    roomMembers = [],
    onLeave,
    onReturnToLobby
}) {
    const gameId = session?.gameId;
    if (!["odd-signal", "pattern-party"].includes(gameId)) {
        throw new Error("Desteklenmeyen bulmaca oyunu.");
    }
    const members = Array.isArray(roomMembers) ? roomMembers : [];
    const matchPlayers = Array.isArray(session?.matchPlayerIds) ? session.matchPlayerIds : [];
    const isMatchPlayer = matchPlayers.includes(uid);
    const root = document.createElement("section");
    root.className = "puzzle-overlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", gameTitles[gameId] + " oyun masası");
    root.innerHTML = `
        <div class="puzzle-shell">
            <header class="puzzle-header">
                <div class="puzzle-brand">
                    <span class="puzzle-kicker"><i></i> RENDECHAT · LIVE ARENA</span>
                    <div class="puzzle-title-row">
                        <span class="puzzle-mark" aria-hidden="true">${gameId === "odd-signal" ? "◈" : "∿"}</span>
                        <div><h1>${gameTitles[gameId]}</h1><p>${gameSubtitles[gameId]}</p></div>
                    </div>
                </div>
                <div class="puzzle-header-actions">
                    <span class="puzzle-live-pill"><i></i> CANLI</span>
                    <button class="puzzle-icon-button" type="button" data-action="close" aria-label="Masayı kapat">×</button>
                </div>
            </header>
            <div class="puzzle-layout">
                <main class="puzzle-main">
                    <div class="puzzle-round-strip">
                        <div><span class="puzzle-eyebrow">BULMACA</span><strong data-role="round">Tur 1 / 8</strong></div>
                        <div class="puzzle-progress" data-role="progress" aria-label="Tur ilerlemesi"></div>
                        <div class="puzzle-timer" data-role="timer">18</div>
                    </div>
                    <section class="puzzle-question-card" data-role="question-section">
                        <div class="puzzle-topic" data-role="topic">MANTIK</div>
                        <h2 data-role="prompt">Sinyal bekleniyor…</h2>
                        <div class="puzzle-options" data-role="options">
                            <button type="button" data-option="0">A</button>
                            <button type="button" data-option="1">B</button>
                            <button type="button" data-option="2">C</button>
                            <button type="button" data-option="3">D</button>
                        </div>
                        <div class="puzzle-feedback" data-role="feedback" aria-live="polite">Sunucuya bağlanılıyor…</div>
                    </section>
                    <section class="puzzle-reveal-card" data-role="reveal" hidden>
                        <div class="puzzle-reveal-icon" data-role="reveal-icon">✓</div>
                        <div><span class="puzzle-eyebrow">CEVAP AÇIKLANDI</span><h2 data-role="reveal-title">Doğru yanıt</h2></div>
                        <p data-role="explanation"></p>
                        <div class="puzzle-next-hint" data-role="next-hint">Sonraki tur hazırlanıyor…</div>
                    </section>
                    <section class="puzzle-results-card" data-role="results" hidden>
                        <div class="puzzle-trophy" aria-hidden="true">✦</div>
                        <span class="puzzle-eyebrow">MAÇ TAMAMLANDI</span>
                        <h2 data-role="winner">Sinyal çözüldü!</h2>
                        <p data-role="result-copy">Puan tablosu aşağıda.</p>
                        <button class="puzzle-primary-button" type="button" data-action="return">Lobiye dön</button>
                    </section>
                    <div class="puzzle-bottom-note">
                        <span>✦</span>
                        <p>Doğru cevap <strong>100 puan</strong>. Hız bonusu ve seri bonusuyla skorunu yükselt.</p>
                    </div>
                </main>
                <aside class="puzzle-sidebar">
                    <div class="puzzle-side-heading"><div><span class="puzzle-eyebrow">OYUNCU SIRALAMASI</span><h3>Skor tablosu</h3></div><span data-role="player-count">0</span></div>
                    <div class="puzzle-scoreboard" data-role="scoreboard"></div>
                    <div class="puzzle-connection" data-role="connection"><i></i><span>Bağlantı kuruluyor…</span></div>
                    <div class="puzzle-howto">
                        <strong>Nasıl oynanır?</strong>
                        <p>Her turda tek bir yanıt seç. Doğru ve hızlı cevaplar daha çok puan kazandırır. Sekiz turun sonunda en yüksek puan kazanır.</p>
                    </div>
                </aside>
            </div>
            <p class="puzzle-error" data-role="error" role="status" aria-live="polite"></p>
        </div>`;
    document.body.appendChild(root);

    const role = (name) => root.querySelector('[data-role="' + name + '"]');
    const action = (name) => root.querySelector('[data-action="' + name + '"]');
    let state = null;
    let connection = null;
    let closed = false;
    let busy = false;
    let timer = null;
    let returned = false;

    function setError(message = "") {
        role("error").textContent = message;
    }

    function setConnection(connected, message) {
        const badge = role("connection");
        badge.classList.toggle("is-online", Boolean(connected));
        badge.querySelector("span").textContent = message || (connected ? "Sunucuya bağlı" : "Yeniden bağlanıyor…");
    }

    function renderScoreboard() {
        const container = role("scoreboard");
        container.replaceChildren();
        if (!state) return;
        role("player-count").textContent = String(state.scoreboard?.length || 0);
        (state.scoreboard || []).forEach((player, index) => {
            const member = memberFor(player.uid, members);
            const row = document.createElement("div");
            row.className = "puzzle-score-row" + (player.uid === uid ? " is-me" : "");
            const rank = document.createElement("span");
            rank.className = "puzzle-rank";
            rank.textContent = String(index + 1).padStart(2, "0");
            const identity = document.createElement("div");
            identity.className = "puzzle-player-identity";
            const name = document.createElement("strong");
            name.textContent = nameFor(player.uid, members, uid);
            const meta = document.createElement("span");
            meta.textContent = player.online ? "Çevrimiçi" : "Yeniden bağlanıyor";
            identity.append(name, meta);
            const points = document.createElement("strong");
            points.className = "puzzle-score-value";
            points.textContent = String(player.score || 0);
            const online = document.createElement("i");
            online.className = "puzzle-online-dot" + (player.online ? " is-online" : "");
            row.append(rank, identity, points, online);
            if (state.phase === "question" && player.answered) {
                const check = document.createElement("span");
                check.className = "puzzle-answered";
                check.textContent = "✓";
                row.appendChild(check);
            } else if (state.phase !== "question" && player.roundPoints != null) {
                const award = document.createElement("span");
                award.className = "puzzle-round-points" + (player.roundPoints > 0 ? " is-positive" : "");
                award.textContent = player.roundPoints > 0 ? "+" + player.roundPoints : "—";
                row.appendChild(award);
            }
            container.appendChild(row);
        });
    }

    function renderOptions() {
        const container = role("options");
        const question = state?.question;
        const answered = state?.myAnswerIndex !== null && state?.myAnswerIndex !== undefined;
        container.replaceChildren();
        if (!question) return;
        question.options.forEach((option, index) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "puzzle-option";
            button.dataset.option = String(index);
            const letter = document.createElement("span");
            letter.className = "puzzle-option-letter";
            letter.textContent = String.fromCharCode(65 + index);
            const text = document.createElement("strong");
            text.textContent = option;
            button.append(letter, text);
            const revealed = state.phase !== "question";
            if (revealed && index === state.correctAnswerIndex) button.classList.add("is-correct");
            if (revealed && answered && index === state.myAnswerIndex && index !== state.correctAnswerIndex) {
                button.classList.add("is-wrong");
            }
            if (answered || !isMatchPlayer || state.phase !== "question" || busy) {
                button.disabled = true;
            }
            button.addEventListener("click", () => {
                void submitAnswer(index);
            });
            container.appendChild(button);
        });
    }

    function renderState() {
        if (!state || closed) return;
        const total = Number(state.totalRounds) || 8;
        const current = Number(state.roundNumber) || 1;
        role("round").textContent = state.phase === "results"
            ? "8 tur tamamlandı"
            : "Tur " + current + " / " + total;
        role("progress").replaceChildren();
        for (let index = 0; index < total; index += 1) {
            const dot = document.createElement("i");
            if (index < current - 1 || state.phase === "results") dot.classList.add("is-done");
            else if (index === current - 1) dot.classList.add("is-current");
            role("progress").appendChild(dot);
        }
        renderScoreboard();

        const questionSection = role("question-section");
        const reveal = role("reveal");
        const results = role("results");
        questionSection.hidden = state.phase !== "question";
        reveal.hidden = state.phase !== "reveal";
        results.hidden = state.phase !== "results";

        if (state.phase === "question") {
            role("topic").textContent = state.question?.topic || "BULMACA";
            role("prompt").textContent = state.question?.prompt || "Bulmaca yükleniyor…";
            renderOptions();
            const answered = state.myAnswerIndex !== null && state.myAnswerIndex !== undefined;
            role("feedback").textContent = !isMatchPlayer
                ? "İzleyici görünümü · Yanıt veremezsin."
                : answered
                    ? "Yanıtın kaydedildi. Diğer oyuncular bekleniyor."
                    : "Dört seçenekten birini seç.";
            role("feedback").classList.toggle("is-answered", answered);
        } else if (state.phase === "reveal") {
            role("reveal-icon").textContent = state.myAnswerIndex === state.correctAnswerIndex ? "✓" : "✦";
            role("reveal-icon").classList.toggle("is-correct", state.myAnswerIndex === state.correctAnswerIndex);
            role("reveal-title").textContent = "Doğru yanıt: " + String.fromCharCode(65 + Number(state.correctAnswerIndex));
            role("explanation").textContent = state.explanation || "";
            const mine = Number(state.roundAwards?.[uid]) || 0;
            role("next-hint").textContent = mine > 0 ? "Bu tur " + mine + " puan kazandın · Sonraki tur geliyor…" : "Sonraki tur geliyor…";
            renderOptions();
        } else if (state.phase === "results") {
            const winners = Array.isArray(state.winnerIds) ? state.winnerIds : [];
            role("winner").textContent = winners.length
                ? (winners.map((id) => nameFor(id, members, uid)).join(" · ") + (winners.length > 1 ? " berabere!" : " kazandı!"))
                : "Maç tamamlandı";
            const top = state.scoreboard?.[0]?.score || 0;
            role("result-copy").textContent = "Sekiz turun sonunda lider skor " + top + " puana ulaştı.";
            action("return").disabled = returned || busy || !isMatchPlayer;
            action("return").textContent = returned ? "Lobiye dönüş kaydedildi" : "Lobiye dön";
            action("return").hidden = !isMatchPlayer;
        }
    }

    function tick() {
        if (closed || !state) return;
        if (state.phase === "question" && Number.isFinite(state.phaseEndsAt)) {
            const remaining = Math.max(0, state.phaseEndsAt - Date.now());
            const seconds = Math.ceil(remaining / 1000);
            role("timer").textContent = String(seconds).padStart(2, "0");
            role("timer").classList.toggle("is-urgent", seconds <= 5);
            const ratio = Math.max(0, Math.min(1, remaining / 18000));
            root.style.setProperty("--puzzle-time", String(ratio * 100) + "%");
        } else if (state.phase === "reveal") {
            const remaining = Math.max(0, state.phaseEndsAt - Date.now());
            role("timer").textContent = String(Math.ceil(remaining / 1000)).padStart(2, "0");
            role("timer").classList.remove("is-urgent");
        } else {
            role("timer").textContent = "—";
            role("timer").classList.remove("is-urgent");
        }
    }

    async function submitAnswer(optionIndex) {
        if (!connection || busy || !isMatchPlayer || state?.phase !== "question" ||
            (state.myAnswerIndex !== null && state.myAnswerIndex !== undefined)) return;
        busy = true;
        setError("");
        renderOptions();
        try {
            await connection.request("answer", { optionIndex });
        } catch (error) {
            setError(error.message || "Yanıt gönderilemedi.");
        } finally {
            busy = false;
            renderState();
        }
    }

    async function leaveMatch() {
        if (busy || closed) return;
        if (!isMatchPlayer || state?.phase === "results") {
            close();
            return;
        }
        busy = true;
        action("close").disabled = true;
        setError("");
        try {
            if (typeof onLeave === "function") {
                const result = await onLeave();
                if (result === false) throw new Error("Maçtan ayrılamadın.");
            } else {
                await returnPuzzleToLobby(null, roomId, session.lobbyId, round, gameId, uid);
            }
            close();
        } catch (error) {
            setError(error.message || "Maçtan ayrılamadın.");
            action("close").disabled = false;
            busy = false;
        }
    }

    async function returnToLobby() {
        if (busy || returned || !isMatchPlayer || state?.phase !== "results") return;
        busy = true;
        action("return").disabled = true;
        setError("");
        try {
            const result = typeof onReturnToLobby === "function"
                ? await onReturnToLobby()
                : await returnPuzzleToLobby(null, roomId, session.lobbyId, round, gameId, uid);
            returned = true;
            action("return").textContent = "Lobiye dönüş kaydedildi";
            setError(result?.completed
                ? "Tüm oyuncular döndü. Yeni maç için hazır olabilirsin."
                : "Lobiye dönüşün kaydedildi. Diğer oyuncular bekleniyor.");
            setTimeout(() => close(), 900);
        } catch (error) {
            setError(error.message || "Lobiye dönülemedi.");
            action("return").disabled = false;
        } finally {
            busy = false;
        }
    }

    function close() {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        timer = null;
        connection?.close();
        connection = null;
        root.remove();
    }

    action("close").addEventListener("click", () => void leaveMatch());
    action("return").addEventListener("click", () => void returnToLobby());

    setConnection(false, "Bulmaca sunucusuna bağlanılıyor…");
    connectToPuzzleGame(null, roomId, session.lobbyId, round, gameId, uid, {
        onState(nextState) {
            if (closed) return;
            state = nextState;
            renderState();
            tick();
        },
        onConnectionState(connected, message) {
            if (closed) return;
            setConnection(connected, message);
        },
        onError(error, source) {
            if (!closed) setError((source ? source + ": " : "") + (error.message || "Bağlantı hatası."));
        }
    }).then((nextConnection) => {
        if (closed) nextConnection.close();
        else connection = nextConnection;
    }).catch((error) => {
        if (!closed) setError(error.message || "Bulmaca sunucusuna bağlanılamadı.");
    });

    if (!isMatchPlayer) role("feedback").textContent = "İzleyici görünümü · Yanıt veremezsin.";
    timer = setInterval(tick, 120);
    return { close, isClosed: () => closed };
}

export const puzzleGame = Object.freeze({
    id: "puzzle",
    name: "RendeChat Puzzle Arena",
    status: "ready",
    minPlayers: 2,
    maxPlayers: 8,
    open: openPuzzleGame
});

export default puzzleGame;
