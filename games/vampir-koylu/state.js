import { auth } from "../../js/firebase.js";
import { UNO_WORKER_URL } from "../uno/worker-config.js";

const BASE_URL = String(UNO_WORKER_URL || "").replace(/\/+$/, "");
const PLACEHOLDER_URL = !BASE_URL ||
    BASE_URL.includes("YOUR-CLOUDFLARE-SUBDOMAIN") ||
    !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(BASE_URL);

function configuredWorkerUrl() {
    if (PLACEHOLDER_URL) {
        throw new Error("Vampir Köylü sunucusu yapılandırılmamış. Worker adresini kontrol et.");
    }
    return BASE_URL;
}

async function getCurrentIdToken(uid) {
    const user = auth.currentUser;
    if (!user || user.uid !== uid) {
        throw new Error("Firebase oturumu değişti. Yeniden giriş yapmalısın.");
    }
    return user.getIdToken();
}

async function workerRequest(roomId, round, uid, action) {
    const token = await getCurrentIdToken(uid);
    const response = await fetch(configuredWorkerUrl() + "/api/vampir-koylu/action", {
        method: "POST",
        headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ roomId, round: Number(round), action })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.error || "Vampir Köylü sunucu işlemi başarısız.");
        error.code = "vampir-koylu-worker-" + response.status;
        throw error;
    }
    return payload;
}

export function forfeitMatch(db, roomId, round, uid) {
    return workerRequest(roomId, round, uid, "quit");
}

export function returnToLobby(db, roomId, round, uid) {
    return workerRequest(roomId, round, uid, "returnToLobby");
}

export async function reconcileMatchPlayers(db, roomId, round, uid) {
    const result = await workerRequest(roomId, round, uid, "reconcile");
    return Boolean(result.reconciled);
}

export async function connectToMatch(db, roomId, round, uid, handlers = {}) {
    const baseUrl = configuredWorkerUrl();
    let socket = null;
    let closed = false;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let requestSequence = 0;
    let connectionGeneration = 0;
    const pending = new Map();

    const notifyConnection = (connected, message = "") => {
        handlers.onConnectionState?.(connected, message);
    };
    const reportError = (error, source = "Bağlantı") => {
        handlers.onError?.(error, source);
    };
    function rejectPending(reason) {
        for (const item of pending.values()) item.reject(reason);
        pending.clear();
    }

    async function requestTicket() {
        const token = await getCurrentIdToken(uid);
        const response = await fetch(baseUrl + "/api/vampir-koylu/ticket", {
            method: "POST",
            headers: {
                Authorization: "Bearer " + token,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ roomId, round: Number(round) })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.webSocketUrl) {
            throw new Error(payload.error || "Vampir Köylü bağlantı bileti alınamadı.");
        }
        return payload.webSocketUrl;
    }

    function handleMessage(message) {
        let payload;
        try {
            payload = JSON.parse(typeof message.data === "string"
                ? message.data
                : String(message.data));
        } catch {
            reportError(new Error("Sunucudan geçersiz veri alındı."), "Sunucu");
            return;
        }

        if (payload.type === "state") {
            handlers.onState?.(payload.state || null);
            return;
        }
        if (payload.type === "private") {
            handlers.onPrivateState?.(payload.privateState || null);
            return;
        }
        if (payload.type === "error") {
            reportError(new Error(payload.error || "Vampir Köylü sunucusu hata verdi."), "Sunucu");
            return;
        }
        if (payload.type === "actionResult") {
            const operation = pending.get(payload.requestId);
            if (!operation) return;
            pending.delete(payload.requestId);
            if (payload.ok) operation.resolve(payload.result);
            else operation.reject(new Error(payload.error || "Hamle reddedildi."));
        }
    }

    async function openConnection(isReconnect = false) {
        if (closed) return;
        const generation = ++connectionGeneration;
        notifyConnection(
            false,
            isReconnect ? "Bağlantı yeniden kuruluyor…" : "Vampir Köylü sunucusuna bağlanılıyor…"
        );

        try {
            const webSocketUrl = await requestTicket();
            if (closed || generation !== connectionGeneration) return;

            const nextSocket = new WebSocket(webSocketUrl);
            socket = nextSocket;
            await new Promise((resolve, reject) => {
                let settled = false;
                nextSocket.addEventListener("open", () => {
                    if (settled || closed || generation !== connectionGeneration) return;
                    settled = true;
                    reconnectAttempt = 0;
                    notifyConnection(true, "Sunucuya bağlandı.");
                    resolve();
                }, { once: true });
                nextSocket.addEventListener("error", () => {
                    if (settled) return;
                    settled = true;
                    reject(new Error("Vampir Köylü WebSocket bağlantısı kurulamadı."));
                }, { once: true });
                nextSocket.addEventListener("message", handleMessage);
                nextSocket.addEventListener("close", () => {
                    if (socket === nextSocket) socket = null;
                    const reason = new Error("Vampir Köylü bağlantısı kesildi.");
                    rejectPending(reason);
                    if (closed || generation !== connectionGeneration) return;
                    notifyConnection(false, "Bağlantı kesildi. Yeniden bağlanılıyor…");
                    reportError(reason, "Bağlantı");
                    const delay = Math.min(1000 * (2 ** reconnectAttempt), 15000);
                    reconnectAttempt += 1;
                    reconnectTimer = setTimeout(() => {
                        reconnectTimer = null;
                        void openConnection(true);
                    }, delay);
                });
            });
        } catch (error) {
            if (closed || generation !== connectionGeneration) return;
            reportError(error, "Vampir Köylü bağlantısı");
            notifyConnection(false, "Bağlantı kurulamadı. Yeniden deneniyor…");
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
            if (closed) return Promise.reject(new Error("Bağlantı kapatıldı."));
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
            connectionGeneration += 1;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = null;
            rejectPending(new Error("Vampir Köylü bağlantısı kapatıldı."));
            const activeSocket = socket;
            socket = null;
            if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) {
                activeSocket.close(1000, "Client closed");
            }
            notifyConnection(false, "Bağlantı kapatıldı.");
        }
    };
}
