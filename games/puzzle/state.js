import { auth } from "../../js/firebase.js";
import { UNO_WORKER_URL } from "../uno/worker-config.js";

const BASE_URL = String(UNO_WORKER_URL || "").replace(/\/+$/, "");
const PLACEHOLDER_URL = !BASE_URL ||
    BASE_URL.includes("YOUR-CLOUDFLARE-SUBDOMAIN") ||
    !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(BASE_URL);

function configuredWorkerUrl() {
    if (PLACEHOLDER_URL) {
        throw new Error("Bulmaca oyunları için Cloudflare Worker adresi games/uno/worker-config.js içinde ayarlanmalı.");
    }
    return BASE_URL;
}

function validateGameId(gameId) {
    if (!["odd-signal", "pattern-party"].includes(gameId)) {
        throw new Error("Bulmaca oyunu kimliği geçersiz.");
    }
    return gameId;
}

async function getCurrentIdToken(uid) {
    const user = auth.currentUser;
    if (!user || user.uid !== uid) throw new Error("Firebase oturumu değişti. Yeniden giriş yapmalısın.");
    return user.getIdToken();
}

async function workerRequest(gameId, roomId, lobbyId, round, uid, action) {
    const token = await getCurrentIdToken(uid);
    const response = await fetch(configuredWorkerUrl() + "/api/" + validateGameId(gameId) + "/action", {
        method: "POST",
        headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ roomId, lobbyId, round: Number(round), action })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.error || "Bulmaca sunucusu işlemi başarısız.");
        error.code = "puzzle-worker-" + response.status;
        throw error;
    }
    return payload;
}

export function forfeitMatch(db, roomId, lobbyId, round, gameId, uid) {
    return workerRequest(gameId, roomId, lobbyId, round, uid, "quit");
}

export function returnToLobby(db, roomId, lobbyId, round, gameId, uid) {
    return workerRequest(gameId, roomId, lobbyId, round, uid, "returnToLobby");
}

export async function reconcileMatchPlayers(db, roomId, lobbyId, round, gameId, uid) {
    const result = await workerRequest(gameId, roomId, lobbyId, round, uid, "reconcile");
    return Boolean(result.reconciled);
}

export async function connectToPuzzleGame(db, roomId, lobbyId, round, gameId, uid, handlers = {}) {
    validateGameId(gameId);
    const baseUrl = configuredWorkerUrl();
    let socket = null;
    let closed = false;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let requestSequence = 0;
    let connectionGeneration = 0;
    const pending = new Map();

    const notifyConnection = (connected, message = "") => handlers.onConnectionState?.(connected, message);
    const reportError = (error, source = "Bağlantı") => handlers.onError?.(error, source);

    function rejectPending(reason) {
        for (const item of pending.values()) item.reject(reason);
        pending.clear();
    }

    async function requestTicket() {
        const token = await getCurrentIdToken(uid);
        const response = await fetch(baseUrl + "/api/" + gameId + "/ticket", {
            method: "POST",
            headers: {
                Authorization: "Bearer " + token,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ roomId, lobbyId, round: Number(round) })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.webSocketUrl) {
            throw new Error(payload.error || "Bulmaca sunucusundan bağlantı bileti alınamadı.");
        }
        return payload.webSocketUrl;
    }

    function handleMessage(message) {
        let payload;
        try {
            payload = JSON.parse(typeof message.data === "string" ? message.data : String(message.data));
        } catch {
            reportError(new Error("Bulmaca sunucusundan geçersiz veri alındı."), "Sunucu");
            return;
        }
        if (payload.type === "state") {
            handlers.onState?.(payload.state || null);
            return;
        }
        if (payload.type === "error") {
            reportError(new Error(payload.error || "Bulmaca sunucusu hata verdi."), "Sunucu");
            return;
        }
        if (payload.type === "actionResult") {
            const operation = pending.get(payload.requestId);
            if (!operation) return;
            pending.delete(payload.requestId);
            if (payload.ok) operation.resolve(payload.result);
            else operation.reject(new Error(payload.error || "Bulmaca hamlesi reddedildi."));
        }
    }

    async function openConnection(isReconnect = false) {
        if (closed) return;
        const generation = ++connectionGeneration;
        notifyConnection(false, isReconnect ? "Bağlantı yeniden kuruluyor…" : "Bulmaca sunucusuna bağlanılıyor…");
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
                    notifyConnection(true, "Bulmaca sunucusuna bağlandı.");
                    resolve();
                }, { once: true });
                nextSocket.addEventListener("error", () => {
                    if (settled) return;
                    settled = true;
                    reject(new Error("Bulmaca WebSocket bağlantısı kurulamadı."));
                }, { once: true });
                nextSocket.addEventListener("message", handleMessage);
                nextSocket.addEventListener("close", () => {
                    if (socket === nextSocket) socket = null;
                    rejectPending(new Error("Bulmaca bağlantısı kesildi."));
                    if (closed || generation !== connectionGeneration) return;
                    notifyConnection(false, "Bağlantı kesildi. Yeniden bağlanılıyor…");
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
            reportError(error, "Bulmaca bağlantısı");
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
            if (closed) return Promise.reject(new Error("Bulmaca bağlantısı kapatıldı."));
            if (!socket || socket.readyState !== WebSocket.OPEN) {
                return Promise.reject(new Error("Bulmaca sunucusuna bağlı değilsin. Yeniden bağlanmayı bekle."));
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
            rejectPending(new Error("Bulmaca bağlantısı kapatıldı."));
            const activeSocket = socket;
            socket = null;
            if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) {
                activeSocket.close(1000, "Client closed");
            }
            notifyConnection(false, "Bağlantı kapatıldı.");
        }
    };
}
