export function isValidLobbyId(lobbyId) {
    return typeof lobbyId === "string" && (lobbyId === "active" || /^[A-Za-z0-9_-]{16,80}$/.test(lobbyId));
}

export function isValidVampirKoyluSessionId(sessionId) {
    return typeof sessionId === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(sessionId);
}

export function getUnoDurableObjectName(roomId, lobbyId, round) {
    if (!isValidRoomId(roomId) || !isValidLobbyId(lobbyId) || !isValidRound(round)) throw new Error("Invalid UNO Durable Object identity.");
    return roomId + ":" + lobbyId + ":" + String(Number(round));
}

export function getVampirKoyluDurableObjectName(roomId, lobbyId, round, sessionId) {
    if (!isValidRoomId(roomId) || !isValidLobbyId(lobbyId) || !isValidRound(round) || !isValidVampirKoyluSessionId(sessionId)) throw new Error("Invalid Vampir Köylü Durable Object identity.");
    return roomId + ":" + lobbyId + ":" + String(Number(round)) + ":" + sessionId;
}

function isValidRoomId(roomId) { return typeof roomId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(roomId); }
function isValidRound(round) { return Number.isInteger(Number(round)) && Number(round) >= 1; }

export function matchesVampirKoyluSession(session, identity) {
    return Boolean(session && identity && session.sessionId === identity.sessionId && Number(session.round) === Number(identity.round));
}
