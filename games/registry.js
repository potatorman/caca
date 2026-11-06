// Game catalog. Lobby availability is separate from whether the game engine is playable.
export const GAME_REGISTRY = Object.freeze([
    Object.freeze({
        id: "uno",
        name: "UNO",
        icon: "🃏",
        description: "UNO oynanışı yakında. Şimdilik lobi akışını ve oyuncu düzenini deneyebilirsin.",
        status: "coming-soon",
        lobbyEnabled: true,
        minPlayers: 2,
        maxPlayers: 10,
        module: "./uno/index.js"
    })
]);

export function getGameDefinition(gameId) {
    return GAME_REGISTRY.find((game) => game.id === gameId) || null;
}
