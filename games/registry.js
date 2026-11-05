// Game catalog. Only modules marked "ready" are offered as playable games.
export const GAME_REGISTRY = Object.freeze([
    Object.freeze({
        id: "uno",
        name: "UNO",
        status: "coming-soon",
        module: "./uno/index.js"
    })
]);

export function getGameDefinition(gameId) {
    return GAME_REGISTRY.find((game) => game.id === gameId) || null;
}
