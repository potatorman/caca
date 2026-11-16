import { auth } from "../../js/firebase.js";
import { STARFALL_WORKER_URL } from "./worker-config.js";

const BASE_URL = String(STARFALL_WORKER_URL || "").replace(/\/+$/, "");
const PLACEHOLDER_URL = !BASE_URL || !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(BASE_URL);

function configuredWorkerUrl() {
    if (PLACEHOLDER_URL) throw new Error("Starfall oyun sunucusu henüz yapılandırılmadı.");
    return BASE_URL;
}

async function getIdToken(uid) {
    const user = auth.currentUser;
    if (!user || user.uid !== uid) throw new Error("Oturum değişti. Yeniden giriş yapmalısın.");
    return user.getIdToken();
}

async function workerRequest(roomId, lobbyId, round, uid, action) {
    const token = await getIdToken(uid);
    const response = await fetch(configuredWorkerUrl() + "/api/starfall/action", {
        method: "POST",
        headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ roomId, lobbyId, round: Number(round), action })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Starfall sunucu işlemi başarısız.");
    return payload;
}

export function forfeitMatch(db, roomId, lobbyId, round, uid) {
    return workerRequest(roomId, lobbyId, round, uid, "quit");
}

export function returnToLobby(db, roomId, lobbyId, round, uid) {
    return workerRequest(roomId, lobbyId, round, uid, "returnToLobby");
}

export async function reconcileMatchPlayers(db, roomId, lobbyId, round, uid) {
    const result = await workerRequest(roomId, lobbyId, round, uid, "reconcile");
    return Boolean(result.reconciled);
}

export async function connectToMatch(db, roomId, lobbyId, round, uid, handlers = {}) {
    const baseUrl = configuredWorkerUrl();
    let socket = null;
    let closed = false;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let generation = 0;
    let requestSequence = 0;
    const pending = new Map();

    const notify = (connected, message) => handlers.onConnectionState?.(connected, message);
    const failPending = (error) => {
        for (const operation of pending.values()) operation.reject(error);
        pending.clear();
    };

    async function requestTicket() {
        const token = await getIdToken(uid);
        const response = await fetch(baseUrl + "/api/starfall/ticket", {
            method: "POST",
            headers: {
                Authorization: "Bearer " + token,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ roomId, lobbyId, round: Number(round) })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.webSocketUrl) {
            throw new Error(payload.error || "Starfall bağlantı bileti alınamadı.");
        }
        return payload.webSocketUrl;
    }

    function onMessage(event) {
        let payload;
        try {
            payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        } catch {
            handlers.onError?.(new Error("Sunucudan geçersiz veri alındı."));
            return;
        }
        if (payload.type === "state") {
            handlers.onState?.(payload.state || null);
        } else if (payload.type === "error") {
            handlers.onError?.(new Error(payload.error || "Starfall sunucusu hata verdi."));
        } else if (payload.type === "actionResult") {
            const operation = pending.get(payload.requestId);
            if (!operation) return;
            pending.delete(payload.requestId);
            if (payload.ok) operation.resolve(payload.result);
            else operation.reject(new Error(payload.error || "Hamle reddedildi."));
        }
    }

    async function openConnection(isReconnect = false) {
        if (closed) return;
        const currentGeneration = ++generation;
        notify(false, isReconnect ? "Bağlantı yeniden kuruluyor…" : "Starfall sunucusuna bağlanılıyor…");
        try {
            const url = await requestTicket();
            if (closed || currentGeneration !== generation) return;
            const nextSocket = new WebSocket(url);
            socket = nextSocket;
            await new Promise((resolve, reject) => {
                let settled = false;
                nextSocket.addEventListener("open", () => {
                    if (settled || closed || currentGeneration !== generation) return;
                    settled = true;
                    reconnectAttempt = 0;
                    notify(true, "Canlı bağlantı kuruldu.");
                    resolve();
                }, { once: true });
                nextSocket.addEventListener("error", () => {
                    if (settled) return;
                    settled = true;
                    reject(new Error("Starfall WebSocket bağlantısı kurulamadı."));
                }, { once: true });
                nextSocket.addEventListener("message", onMessage);
                nextSocket.addEventListener("close", () => {
                    if (socket === nextSocket) socket = null;
                    failPending(new Error("Bağlantı yenilendi. Hamleni tekrar deneyebilirsin."));
                    if (closed || currentGeneration !== generation) return;
                    notify(false, "Bağlantı kesildi; yeniden bağlanılıyor…");
                    const delay = Math.min(1000 * (2 ** reconnectAttempt), 15000);
                    reconnectAttempt += 1;
                    reconnectTimer = setTimeout(() => {
                        reconnectTimer = null;
                        void openConnection(true);
                    }, delay);
                });
            });
        } catch (error) {
            if (closed || currentGeneration !== generation) return;
            handlers.onError?.(error);
            notify(false, "Bağlantı kurulamadı; yeniden deneniyor…");
            const delay = Math.min(1000 * (2 ** reconnectAttempt), 15000);
            reconnectAttempt += 1;
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                void openConnection(true);
            }, delay);
        }
    }

    await openConnection(false);
    return {
        request(type, values = {}) {
            if (closed) return Promise.reject(new Error("Oyun bağlantısı kapalı."));
            if (!socket || socket.readyState !== WebSocket.OPEN) {
                return Promise.reject(new Error("Sunucuya bağlı değilsin. Yeniden bağlanmayı bekle."));
            }
            const requestId = Date.now().toString(36) + "-" + (++requestSequence).toString(36);
            return new Promise((resolve, reject) => {
                pending.set(requestId, { resolve, reject });
                try {
                    socket.send(JSON.stringify({ ...values, type, requestId }));
                } catch (error) {
                    pending.delete(requestId);
                    reject(error);
                }
            });
        },
        close() {
            if (closed) return;
            closed = true;
            generation += 1;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = null;
            failPending(new Error("Oyun bağlantısı kapatıldı."));
            const activeSocket = socket;
            socket = null;
            if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) {
                activeSocket.close(1000, "Client closed");
            }
            notify(false, "Bağlantı kapatıldı.");
        }
    };
}
