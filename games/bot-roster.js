const GAME_LIMITS = Object.freeze({
    uno: Object.freeze({ minPlayers: 2, maxPlayers: 10 }),
    starfall: Object.freeze({ minPlayers: 2, maxPlayers: 8 })
});
const BOT_NAMES = Object.freeze([
    "Mert", "Elif", "Zeynep", "Arda", "Ece", "Kerem",
    "Deniz", "Ada", "Bora", "Defne", "Can", "Selin"
]);

export function createGameBotRoster(gameId, humanPlayerIds, settings = {}, round = 1) {
    const limits = GAME_LIMITS[gameId];
    if (!limits) throw new Error("Bu oyun için bot desteği bulunmuyor.");
    if (!Array.isArray(humanPlayerIds) || humanPlayerIds.length < 1 ||
        humanPlayerIds.length > limits.maxPlayers ||
        humanPlayerIds.some((id) => typeof id !== "string" || !id) ||
        new Set(humanPlayerIds).size !== humanPlayerIds.length) {
        throw new Error("Gerçek oyuncu listesi geçersiz.");
    }
    if (!Number.isInteger(round) || round < 1) throw new Error("Oyun turu geçersiz.");

    const botFillEnabled = settings?.botFillEnabled === true;
    const targetPlayerCount = settings?.targetPlayerCount === undefined
        ? limits.minPlayers
        : Number(settings.targetPlayerCount);
    if (!Number.isInteger(targetPlayerCount) ||
        targetPlayerCount < limits.minPlayers ||
        targetPlayerCount > limits.maxPlayers) {
        throw new Error("Bot hedef oyuncu sayısı bu oyun için geçersiz.");
    }
    if (botFillEnabled && humanPlayerIds.length > targetPlayerCount) {
        throw new Error("Gerçek oyuncu sayısı bot hedefinden fazla olamaz.");
    }
    if (!botFillEnabled && humanPlayerIds.length < limits.minPlayers) {
        throw new Error("Botlar kapalı. Bu oyun için yeterli gerçek oyuncu gerekli.");
    }

    const humans = [...humanPlayerIds];
    const usedIds = new Set(humans);
    const botCount = botFillEnabled ? targetPlayerCount - humans.length : 0;
    const botRoster = Array.from({ length: botCount }, (_, index) => {
        let suffix = index + 1;
        let id = "bot-" + gameId + "-" + round + "-" + suffix;
        while (usedIds.has(id)) {
            suffix += 1;
            id = "bot-" + gameId + "-" + round + "-" + suffix;
        }
        usedIds.add(id);
        return {
            id,
            name: BOT_NAMES[(round + index - 1) % BOT_NAMES.length] + " · Bot"
        };
    });
    const botPlayerIds = botRoster.map((bot) => bot.id);
    const botNames = Object.fromEntries(botRoster.map((bot) => [bot.id, bot.name]));
    return {
        botFillEnabled,
        targetPlayerCount,
        humanPlayerIds: humans,
        botRoster,
        botPlayerIds,
        botNames,
        playerIds: [...humans, ...botPlayerIds]
    };
}
