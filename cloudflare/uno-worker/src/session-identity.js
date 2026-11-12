export function isValidVampirKoyluSessionId(sessionId) {
    return typeof sessionId === "string" &&
        /^[A-Za-z0-9_-]{16,80}$/.test(sessionId);
}

export function getVampirKoyluDurableObjectName(roomId, round, sessionId) {
    if (
        typeof roomId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(roomId) ||
        !Number.isInteger(Number(round)) ||
        Number(round) < 1 ||
        !isValidVampirKoyluSessionId(sessionId)
    ) {
        throw new Error("Invalid Vampir Köylü Durable Object identity.");
    }
    return roomId + ":" + String(Number(round)) + ":" + sessionId;
}

export function matchesVampirKoyluSession(session, identity) {
    return Boolean(
        session &&
        identity &&
        session.sessionId === identity.sessionId &&
        Number(session.round) === Number(identity.round)
    );
}
