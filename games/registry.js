// Game catalog. Multiplayer capability is opt-in and separate from standalone launch support.
export const GAME_REGISTRY = Object.freeze([
    Object.freeze({
        id: "uno",
        name: "UNO",
        icon: "🃏",
        category: "KART OYUNU",
        description: "2–10 oyunculu gerçek zamanlı UNO. Klasik kartlar, renk seçimi ve UNO cezası.",
        status: "ready",
        launchMode: "lobby",
        lobbyEnabled: true,
        minPlayers: 2,
        maxPlayers: 10,
        module: "./uno/index.js"
    }),
    Object.freeze({
        id: "vampir-koylu",
        name: "Vampir Köylü",
        icon: "🌙",
        category: "SOSYAL STRATEJİ",
        description: "5–12 oyuncu. Vampir, doktor ve köylüler; gizli gece hamleleri, tartışma ve oylama.",
        status: "ready",
        launchMode: "lobby",
        lobbyEnabled: true,
        minPlayers: 5,
        maxPlayers: 12,
        module: "./vampir-koylu/index.js"
    }),
    Object.freeze({
        id: "breakout",
        name: "Breakout",
        icon: "🧱",
        category: "ARCADE",
        description: "Klasik tuğla kırma oyunu. Tek başına veya aynı cihazda iki kişi sırayla oyna.",
        status: "ready",
        launchMode: "standalone",
        lobbyEnabled: false,
        minPlayers: 1,
        maxPlayers: 2,
        module: "./breakout/index.js",
        credits: "J. Toivonen",
        license: "MIT",
        sourceUrl: "https://github.com/toivjon/html5-breakout"
    }),
    Object.freeze({
        id: "space-invaders",
        name: "Space Invaders",
        icon: "👾",
        category: "ARCADE",
        description: "Uzaylı dalgalarına karşı savaş. Tek başına veya aynı cihazda iki kişilik sıra tabanlı mod.",
        status: "ready",
        launchMode: "standalone",
        lobbyEnabled: false,
        minPlayers: 1,
        maxPlayers: 2,
        module: "./space-invaders/index.js",
        credits: "Jon Toivonen",
        license: "MIT",
        sourceUrl: "https://github.com/toivjon/html5-space-invaders"
    })
]);

export function getGameDefinition(gameId) {
    return GAME_REGISTRY.find((game) => game.id === gameId && game.launchMode === "lobby") || null;
}
