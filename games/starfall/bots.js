import { scoreStarfallClaim } from "./engine.js";

function pick(values, random) {
    if (!values.length) return null;
    const sample = Number(random());
    const fraction = Number.isFinite(sample) ? Math.max(0, Math.min(0.999999, sample)) : 0;
    return values[Math.floor(fraction * values.length)];
}

export function chooseStarfallBotMove(board, uid, random = Math.random) {
    if (!Array.isArray(board) || typeof uid !== "string" || !uid) return null;
    const options = [];
    for (let index = 0; index < board.length; index += 1) {
        if (!board[index] || board[index].ownerId) continue;
        const score = scoreStarfallClaim(board, index, uid);
        options.push({ index, score });
    }
    if (!options.length) return null;
    const highest = Math.max(...options.map((option) => option.score.totalPoints));
    const best = options.filter((option) => option.score.totalPoints === highest);
    return pick(best, random)?.index ?? null;
}
