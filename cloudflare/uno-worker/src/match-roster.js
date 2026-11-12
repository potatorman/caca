export function shouldRefreshUnconnectedRoster({
    role,
    uid,
    sessionPlayers,
    matchPlayerIds,
    sessionStatus,
    matchStatus,
    hasAcceptedConnection,
    activeSocketCount
}) {
    return role === "player" &&
        Array.isArray(sessionPlayers) && sessionPlayers.includes(uid) &&
        Array.isArray(matchPlayerIds) && !matchPlayerIds.includes(uid) &&
        sessionStatus === "playing" &&
        matchStatus === "playing" &&
        hasAcceptedConnection !== true &&
        activeSocketCount === 0;
}
