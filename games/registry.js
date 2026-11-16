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
    }),
    Object.freeze({
        id: "vampir-koylu",
        name: "Vampir Köylü",
        icon: "🌙",
        description: "5–12 oyuncu. Vampir, doktor ve köylüler; gizli gece hamleleri, tartışma ve oylama.",
        status: "ready",
        lobbyEnabled: true,
        minPlayers: 5,
        maxPlayers: 12,
        module: "./vampir-koylu/index.js"
    }),
    Object.freeze({
        id: "odd-signal",
        name: "Odd Signal",
        icon: "◈",
        description: "2–8 oyuncu. Dört seçenekten gruba ait olmayanı bul; hız ve seri bonuslarıyla puan topla.",
        status: "ready",
        lobbyEnabled: true,
        minPlayers: 2,
        maxPlayers: 8,
        module: "./puzzle/index.js"
    }),
    Object.freeze({
        id: "pattern-party",
        name: "Pattern Party",
        icon: "∿",
        description: "2–8 oyuncu. Sayı dizilerini tamamla; sekiz turda en yüksek skora ulaş.",
        status: "ready",
        lobbyEnabled: true,
        minPlayers: 2,
        maxPlayers: 8,
        module: "./puzzle/index.js"
    })
]);

export function getGameDefinition(gameId) {
    return GAME_REGISTRY.find((game) => game.id === gameId) || null;
}
