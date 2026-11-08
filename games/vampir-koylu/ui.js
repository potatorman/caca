import { setAvatarElement } from "../../js/avatars.js";
import { connectToMatch } from "./state.js";

const ROLE_LABELS = Object.freeze({
    vampir: "Vampir",
    doktor: "Doktor",
    koylu: "Köylü"
});

const ROLE_DESCRIPTIONS = Object.freeze({
    vampir: "Diğer vampirlerle birlikte her gece bir köylüyü hedef seç. Gündüz kimliğini gizle ve köylüleri yanılt.",
    doktor: "Her gece bir oyuncuyu koru. Vampirlerin hedef aldığı kişiyi seçersen onu kurtarırsın. Kendini de koruyabilirsin.",
    koylu: "Özel bir gece yeteneğin yok. Gündüz tartışmasına katıl, şüphelileri değerlendir ve oylamada vampirleri bul."
});

const memberOf = (id, members) => members.find((member) => member.id === id) || null;
const labelPlayer = (id, members, myId, botNames = {}) => {
    const botName = botNames?.[id];
    if (botName) return botName + " · Bot";
    const member = memberOf(id, members);
    const name = member?.displayNickname || member?.username || "Oyuncu";
    return id === myId ? name + " · Sen" : name;
};

function localizeMessage(message, state, members, uid) {
    let result = String(message || "");
    for (const id of state?.playerIds || []) {
        result = result.split(id).join(labelPlayer(id, members, uid, state?.botNames));
    }
    return result;
}

export async function openVampirKoyluGame({
    db, roomId, round, uid, session, roomMembers = [], onLeave, onReturnToLobby
}) {
    const members = Array.isArray(roomMembers) ? roomMembers : [];
    const isMatchPlayer = ["playing", "results"].includes(session?.status) &&
        Array.isArray(session?.matchPlayerIds) &&
        session.matchPlayerIds.includes(uid);

    const root = document.createElement("section");
    root.className = "vampir-overlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Vampir Köylü masası");
    root.innerHTML = `
        <div class="vampir-shell">
            <header class="vampir-header">
                <div>
                    <span class="vampir-eyebrow">CACA · ODA OYUNU</span>
                    <h2>Vampir Köylü</h2>
                    <p class="vampir-status" data-role="status">Oyun sunucusuna bağlanılıyor…</p>
                </div>
                <button class="vampir-close" type="button" data-action="close"
                    aria-label="Maçı terk et" title="Maçı terk et">×</button>
            </header>

            <div class="vampir-layout">
                <aside class="vampir-sidebar">
                    <section class="vampir-role-card" data-role="role-card">
                        <span class="vampir-section-label">GİZLİ ROLÜN</span>
                        <strong data-role="role-name">Rol bekleniyor…</strong>
                        <p data-role="role-description">Rolün yalnızca sana gösterilir.</p>
                        <div class="vampir-team" data-role="team" hidden></div>
                    </section>
                    <section class="vampir-player-panel">
                        <div class="vampir-panel-heading">
                            <strong>Köy halkı</strong>
                            <span data-role="alive-count">0 hayatta</span>
                        </div>
                        <div class="vampir-player-list" data-role="players"></div>
                    </section>
                </aside>

                <main class="vampir-main">
                    <section class="vampir-phase-card">
                        <div class="vampir-phase-topline">
                            <span class="vampir-phase-badge" data-role="phase">GECE</span>
                            <span class="vampir-day-count" data-role="day-count">1. gece</span>
                            <span class="vampir-timer" data-role="timer">--:--</span>
                        </div>
                        <h3 data-role="phase-title">Gece çöktü</h3>
                        <p class="vampir-public-message" data-role="public-message">
                            Vampirler ve doktor gizli seçimlerini yapıyor.
                        </p>
                    </section>

                    <section class="vampir-action-card">
                        <div class="vampir-action-heading">
                            <span class="vampir-section-label">SENİN HAMLELERİN</span>
                            <span class="vampir-action-state" data-role="action-state"></span>
                        </div>
                        <div class="vampir-targets" data-role="targets"></div>
                        <p class="vampir-hint" data-role="hint">
                            Gündüz herkes mevcut oda sohbetinde tartışabilir.
                        </p>
                    </section>

                    <section class="vampir-chat-card" data-role="chat-card">
                        <div class="vampir-chat-heading">
                            <div>
                                <span class="vampir-section-label">KÖY MEYDANI</span>
                                <strong>Gündüz sohbeti</strong>
                            </div>
                            <span data-role="chat-count">0 mesaj</span>
                        </div>
                        <div class="vampir-chat-messages" data-role="chat-messages"
                            aria-live="polite" aria-relevant="additions"></div>
                        <form class="vampir-chat-form" data-role="chat-form">
                            <input data-role="chat-input" type="text" maxlength="400"
                                placeholder="Köy halkına söyleyeceklerin…" autocomplete="off">
                            <button class="vampir-primary" type="submit" data-action="send-chat">Gönder</button>
                        </form>
                        <p class="vampir-hint" data-role="chat-hint">
                            Sohbet sadece gündüz açıktır. Yalnızca hayatta olan oyuncular mesaj gönderebilir.
                        </p>
                    </section>
                    <p class="vampir-message" data-role="message" aria-live="polite"></p>
                </main>
            </div>

            <div class="vampir-result-modal" data-role="result" hidden>
                <div class="vampir-result-card">
                    <span class="vampir-eyebrow">MAÇ SONUCU</span>
                    <h2 data-role="winner">Oyun bitti</h2>
                    <p data-role="result-message"></p>
                    <div class="vampir-result-roles" data-role="result-roles"></div>
                    <p class="vampir-result-hint">5 saniye sonra otomatik olarak lobiye dönülecek.</p>
                    <button class="vampir-primary" type="button" data-action="return">Lobiye dön</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(root);

    const role = (name) => root.querySelector('[data-role="' + name + '"]');
    const action = (name) => root.querySelector('[data-action="' + name + '"]');

    let state = null;
    let privateState = null;
    let connection = null;
    let busy = false;
    let closed = false;
    let ticker = null;
    let resultAutoCloseTimer = null;
    let resultAutoCloseScheduled = false;

    function setStatus(message) {
        role("status").textContent = message || "";
    }

    function setMessage(message = "", isError = false) {
        const target = role("message");
        target.textContent = message;
        target.classList.toggle("is-error", Boolean(isError));
    }

    function phaseTitle() {
        if (state?.phase === "night") return "Gece çöktü";
        if (state?.phase === "day") return "Gün doğdu";
        if (state?.phase === "voting") return "Köy oylama yapıyor";
        return "Oyun tamamlandı";
    }

    function phaseLabel() {
        if (state?.phase === "night") return "GECE";
        if (state?.phase === "day") return "GÜNDÜZ";
        if (state?.phase === "voting") return "OYLAMA";
        return "SONUÇ";
    }

    function renderRole() {
        const roleId = privateState?.role;
        role("role-name").textContent = ROLE_LABELS[roleId] || "Rol bekleniyor…";
        role("role-description").textContent = ROLE_DESCRIPTIONS[roleId] ||
            "Rolün yalnızca sana gösterilir.";
        role("role-card").classList.toggle("is-vampire", roleId === "vampir");
        role("role-card").classList.toggle("is-doctor", roleId === "doktor");
        role("role-card").classList.toggle("is-villager", roleId === "koylu");

        const team = role("team");
        team.replaceChildren();
        team.hidden = roleId !== "vampir";
        if (roleId === "vampir") {
            const title = document.createElement("strong");
            title.textContent = "Vampir takımın";
            const names = document.createElement("span");
            const teammates = privateState?.vampireTeammates || [];
            names.textContent = teammates.length
                ? teammates.map((id) => labelPlayer(id, members, uid, state?.botNames)).join(", ")
                : "Tek vampirsin.";
            team.append(title, names);
        }
    }

    function renderPlayers() {
        const list = role("players");
        list.replaceChildren();
        if (!state) return;

        const alive = new Set(state.alivePlayerIds || []);
        role("alive-count").textContent = alive.size + " hayatta";

        for (const id of state.playerIds || []) {
            const member = memberOf(id, members);
            const isAlive = alive.has(id);
            const row = document.createElement("article");
            row.className = "vampir-player" +
                (isAlive ? " is-alive" : " is-dead") +
                (id === uid ? " is-you" : "");

            const avatar = document.createElement("span");
            avatar.className = "vampir-avatar";
            if (state.botNames?.[id]) {
                avatar.classList.add("is-bot");
                avatar.textContent = "🤖";
            } else {
                setAvatarElement(avatar, member?.avatarId, member?.avatarData);
            }

            const details = document.createElement("span");
            details.className = "vampir-player-details";
            const name = document.createElement("strong");
            name.textContent = labelPlayer(id, members, uid);
            const meta = document.createElement("small");
            const revealedRole = state.revealedRoles?.[id];
            meta.textContent = isAlive
                ? "Hayatta"
                : revealedRole ? "Elendi · " + ROLE_LABELS[revealedRole] : "Elendi";
            details.append(name, meta);

            const marker = document.createElement("span");
            marker.className = "vampir-player-marker";
            marker.textContent = isAlive ? "●" : "×";
            row.append(avatar, details, marker);
            list.appendChild(row);
        }
    }

    function createTargetButton(id, label, selected, onClick) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "vampir-target-button" + (selected ? " is-selected" : "");
        button.textContent = label + (selected ? " · Seçildi" : "");
        button.disabled = busy || closed;
        button.addEventListener("click", onClick);
        return button;
    }

    function renderTargets() {
        const container = role("targets");
        container.replaceChildren();

        if (!state || state.status !== "playing" || !privateState) {
            role("action-state").textContent = "";
            role("hint").textContent = "Oyun verisi bekleniyor…";
            return;
        }

        const isAlive = privateState.alive;
        const alive = state.alivePlayerIds || [];
        const phase = state.phase;
        const currentRole = privateState.role;
        const targets = [];

        if (!isAlive) {
            role("action-state").textContent = "ELENDİN";
            role("hint").textContent = "Artık hamle yapamazsın. Oyunu izleyebilirsin.";
            return;
        }

        if (phase === "night" && currentRole === "vampir") {
            const teammates = new Set(privateState.vampireTeammates || []);
            for (const id of alive) {
                if (id === uid || teammates.has(id)) continue;
                targets.push(id);
            }
            role("action-state").textContent = privateState.hasActed
                ? "Hedef seçildi · Değiştirebilirsin"
                : "Gizlice bir köylü seç";
            role("hint").textContent = "Vampirler aynı hedefte çoğunluk sağlarsa o oyuncu saldırıya uğrar. Eşitlikte kimse ölmez.";
        } else if (phase === "night" && currentRole === "doktor") {
            targets.push(...alive);
            role("action-state").textContent = privateState.hasActed
                ? "Koruma hedefi seçildi · Değiştirebilirsin"
                : "Bu gece koruyacağın kişiyi seç";
            role("hint").textContent = "Vampirlerin hedef aldığı oyuncuyu seçersen onu kurtarırsın. Kendini de koruyabilirsin.";
        } else if (phase === "voting") {
            for (const id of alive) {
                if (id === uid) continue;
                targets.push(id);
            }
            role("action-state").textContent = privateState.hasActed
                ? "Oyun kaydedildi · Oyunu değiştirebilirsin"
                : "Şüphelendiğin kişiye oy ver";
            role("hint").textContent = "En çok oyu alan oyuncu köyden gönderilir. Eşitlikte kimse elenmez.";
        } else if (phase === "night") {
            role("action-state").textContent = "GİZLİ GECE";
            role("hint").textContent = "Bu gece özel bir hamlen yok. Sabahı bekle.";
        } else if (phase === "day") {
            role("action-state").textContent = "TARTIŞMA";
            role("hint").textContent = "Oda sohbetinde konuşun. Süre bittiğinde oylama başlayacak.";
        } else {
            role("action-state").textContent = "";
            role("hint").textContent = "";
        }

        if (!targets.length) {
            const empty = document.createElement("p");
            empty.className = "vampir-no-targets";
            empty.textContent = phase === "voting"
                ? "Oy verebileceğin başka hayatta oyuncu kalmadı."
                : "Seçilebilecek hedef yok.";
            container.appendChild(empty);
            return;
        }

        for (const id of targets) {
            const selected = privateState.selectedTargetUid === id;
            const button = createTargetButton(
                id,
                labelPlayer(id, members, uid),
                selected,
                () => {
                    const requestType = phase === "voting" ? "vote" : "nightAction";
                    void perform(
                        () => connection.request(requestType, { targetUid: id }),
                        phase === "voting" ? "Oyun kaydedildi." : "Seçimin sunucuya gönderildi."
                    );
                }
            );
            container.appendChild(button);
        }
    }

    function renderDiscussion() {
        const container = role("chat-messages");
        const messages = Array.isArray(state?.discussionMessages)
            ? state.discussionMessages
            : [];
        const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 72;
        container.replaceChildren();
        role("chat-count").textContent = messages.length + " mesaj";

        for (const item of messages) {
            const row = document.createElement("article");
            row.className = "vampir-chat-message" + (item.uid === uid ? " is-you" : "");
            const heading = document.createElement("div");
            heading.className = "vampir-chat-message-heading";
            const name = document.createElement("strong");
            name.textContent = labelPlayer(item.uid, members, uid, state?.botNames);
            const day = document.createElement("span");
            day.textContent = item.dayNumber ? item.dayNumber + ". gün" : "";
            heading.append(name, day);
            const body = document.createElement("p");
            body.textContent = item.text || "";
            row.append(heading, body);
            container.appendChild(row);
        }

        if (!messages.length) {
            const empty = document.createElement("p");
            empty.className = "vampir-chat-empty";
            empty.textContent = "Henüz mesaj yok. Tartışmayı başlatabilirsin.";
            container.appendChild(empty);
        }
        if (nearBottom || messages.length <= 2) container.scrollTop = container.scrollHeight;

        const canTalk = state?.status === "playing" &&
            state.phase === "day" &&
            Boolean(privateState?.alive);
        role("chat-input").disabled = busy || !canTalk;
        action("send-chat").disabled = busy || !canTalk;
        role("chat-hint").textContent = !privateState?.alive
            ? "Elendiğin için artık tartışmaya mesaj gönderemezsin."
            : state?.phase === "day"
                ? "Yalnızca hayatta olan oyuncular gündüz mesaj gönderebilir."
                : "Sohbet yalnızca gündüz aşamasında açıktır.";
    }

    function renderResult() {
        const team = state?.winnerTeam;
        role("winner").textContent = team === "koyluler"
            ? "Köylüler kazandı!"
            : team === "vampirler"
                ? "Vampirler kazandı!"
                : "Maç sona erdi";
        role("result-message").textContent = localizeMessage(
            state?.publicMessage,
            state,
            members,
            uid
        );

        const list = role("result-roles");
        list.replaceChildren();
        for (const id of state?.playerIds || []) {
            const row = document.createElement("div");
            row.className = "vampir-result-role";
            const name = document.createElement("span");
            name.textContent = labelPlayer(id, members, uid);
            const roleLabel = document.createElement("strong");
            roleLabel.textContent = ROLE_LABELS[state?.revealedRoles?.[id]] || "—";
            row.append(name, roleLabel);
            list.appendChild(row);
        }
        role("result").hidden = false;
    }

    function render() {
        if (!state || closed) return;
        renderRole();
        renderPlayers();
        role("phase").textContent = phaseLabel();
        role("day-count").textContent = state.dayNumber
            ? state.dayNumber + ". gün"
            : "";
        role("phase-title").textContent = phaseTitle();
        role("public-message").textContent = localizeMessage(
            state.publicMessage,
            state,
            members,
            uid
        );
        role("timer").textContent = state.phaseEndsAt
            ? Math.max(0, Math.ceil((state.phaseEndsAt - Date.now()) / 1000)) + " sn"
            : "—";
        renderDiscussion();

        role("phase").className = "vampir-phase-badge is-" + (state.phase || "unknown");
        role("phase-title").className = "vampir-phase-title is-" + (state.phase || "unknown");

        if (state.phase === "voting") {
            role("action-state").textContent = privateState?.hasActed
                ? "Oy kullanıldı · " + state.votesSubmitted + "/" + state.votesRequired
                : "Oyunu kullan · " + state.votesSubmitted + "/" + state.votesRequired;
        }

        if (state.status === "results") {
            renderResult();
            if (!resultAutoCloseScheduled) {
                resultAutoCloseScheduled = true;
                resultAutoCloseTimer = setTimeout(autoReturnFromResults, 5000);
            }
        } else {
            role("result").hidden = true;
            if (resultAutoCloseTimer !== null) {
                clearTimeout(resultAutoCloseTimer);
                resultAutoCloseTimer = null;
            }
            resultAutoCloseScheduled = false;
        }
        renderTargets();
    }

    async function perform(task, successText = "") {
        if (busy || closed) return;
        busy = true;
        renderTargets();
        try {
            await task();
            if (successText) setMessage(successText);
        } catch (error) {
            setMessage(error?.message || "İşlem tamamlanamadı.", true);
        } finally {
            busy = false;
            if (!closed) render();
        }
    }

    function close() {
        if (closed) return;
        closed = true;
        if (ticker !== null) clearInterval(ticker);
        ticker = null;
        if (resultAutoCloseTimer !== null) clearTimeout(resultAutoCloseTimer);
        resultAutoCloseTimer = null;
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
        void returnFromResults();
    }

    async function returnFromResults() {
        if (state?.status !== "results" || typeof onReturnToLobby !== "function") {
            close();
            return;
        }
        if (busy) return;
        busy = true;
        action("return").disabled = true;
        try {
            setStatus("Lobiye dönüş kaydediliyor…");
            const result = await onReturnToLobby();
            setStatus(result?.completed
                ? "Tüm oyuncular döndü. Yeni lobi açıldı."
                : "Lobiye döndün. Diğer oyuncular bekleniyor (" +
                    (result?.returnedCount ?? 1) + "/" +
                    (result?.requiredCount ?? "…") + ").");
            close();
        } catch (error) {
            setMessage(error?.message || "Lobiye dönülemedi.", true);
            busy = false;
            action("return").disabled = false;
        }
    }

    action("close").addEventListener("click", async () => {
        if (busy || closed) return;
        if (state?.status === "results") {
            await returnFromResults();
            return;
        }
        const activeMatchPlayer = state?.status === "playing" &&
            Array.isArray(state.playerIds) &&
            state.playerIds.includes(uid);
        if (!activeMatchPlayer) {
            close();
            return;
        }
        if (!window.confirm("Maçı terk etmek istiyor musun? Artık rolünle oynayamayacaksın.")) {
            return;
        }
        busy = true;
        action("close").disabled = true;
        try {
            if (typeof onLeave !== "function") throw new Error("Maçtan çıkış işlemi kullanılamıyor.");
            const result = await onLeave();
            if (result === false) throw new Error("Maçtan çıkış tamamlanmadı.");
            close();
        } catch (error) {
            setMessage(error?.message || "Maçtan çıkış başarısız.", true);
            busy = false;
            action("close").disabled = false;
        }
    });

    action("return").addEventListener("click", () => void returnFromResults());
    role("chat-form").addEventListener("submit", (event) => {
        event.preventDefault();
        if (busy || state?.phase !== "day" || !privateState?.alive) return;
        const input = role("chat-input");
        const message = input.value.trim();
        if (!message) return;
        input.value = "";
        void perform(
            () => connection.request("sendMessage", { text: message }),
            ""
        );
    });

    connectToMatch(db, roomId, round, uid, {
        onState(nextState) {
            if (closed) return;
            state = nextState;
            if (state) {
                setStatus(state.status === "results" ? "Maç tamamlandı" : "Vampir Köylü oynanıyor");
                render();
            }
        },
        onPrivateState(nextPrivateState) {
            if (closed) return;
            privateState = nextPrivateState;
            render();
        },
        onConnectionState(connected, message) {
            if (closed) return;
            if (!connected) setStatus(message || "Sunucuya bağlanılıyor…");
            else if (!state) setStatus("Sunucuya bağlandı. Oyun verisi bekleniyor…");
        },
        onError(error, source) {
            if (!closed) setMessage(
                (source ? source + ": " : "") + (error?.message || "Bağlantı kurulamadı."),
                true
            );
        }
    }).then((nextConnection) => {
        if (closed) nextConnection.close();
        else connection = nextConnection;
    }).catch((error) => {
        if (!closed) setMessage(error?.message || "Sunucuya bağlanılamadı.", true);
    });

    ticker = setInterval(() => {
        if (closed || !state) return;
        if (state.phaseEndsAt) {
            role("timer").textContent =
                Math.max(0, Math.ceil((state.phaseEndsAt - Date.now()) / 1000)) + " sn";
        }
    }, 250);

    if (!isMatchPlayer) setStatus("İzleyici görünümü. Gizli roller oyunculara özeldir.");
    return { close, isClosed: () => closed };
}
