// Game catalog. Lobby availability is separate from whether the game engine is playable.
export const GAME_REGISTRY = Object.freeze([
    Object.freeze({
        id: "uno",
        name: "UNO",
        icon: "🃏",
        description: "2–10 oyunculu gerçek zamanlı UNO. Klasik kartlar, renk seçimi ve UNO cezası.",
        status: "ready",
        lobbyEnabled: true,
        minPlayers: 2,
        maxPlayers: 10,
        module: "./uno/index.js"
    })
]);

export function getGameDefinition(gameId) {
    return GAME_REGISTRY.find((game) => game.id === gameId) || null;
}
