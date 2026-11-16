// Shared lobby selection rules. The public lobby list is global, but automatic
// opening is scoped to the signed-in user's own participation.
export function isActiveGameLobby(session) {
    return ["lobby", "starting", "playing", "results"].includes(session?.status);
}

export function isUserInGameLobby(session, userId) {
    if (!userId || !isActiveGameLobby(session)) return false;
    return session.hostId === userId ||
        ["playerIds", "readyIds", "matchPlayerIds", "spectatorIds",
            "nextRoundPlayerIds", "nextRoundReadyIds", "resultReturnIds"]
            .some((field) => Array.isArray(session[field]) && session[field].includes(userId));
}

export function selectGameLobbyForUser(sessions, userId, previouslySelectedLobbyId = "") {
    const active = [...sessions.values()].filter(isActiveGameLobby);
    const joinedActiveLobby = active.find((session) => isUserInGameLobby(session, userId)) || null;
    const ownedActiveLobby = active.find((session) => session.hostId === userId) || null;
    const explicitSelection = previouslySelectedLobbyId
        ? sessions.get(previouslySelectedLobbyId)
        : null;
    const selectedSession = joinedActiveLobby ||
        (isActiveGameLobby(explicitSelection) ? explicitSelection : null);

    return { joinedActiveLobby, ownedActiveLobby, selectedSession };
}
