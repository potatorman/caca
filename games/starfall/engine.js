// Starfall Grid: a server-authoritative territory drafting game.
export const BOARD_SIZE = 6;
export const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;
export const TURNS_PER_PLAYER = 4;
export const MAX_PLAYERS = 8;
export const STAR_COUNT = 6;

export function createStarfallBoard(random = Math.random) {
    const stars = new Set();
    while (stars.size < STAR_COUNT) {
        stars.add(Math.floor(random() * BOARD_CELLS));
    }
    return Array.from({ length: BOARD_CELLS }, (_, index) => ({
        index,
        value: 1 + Math.floor(random() * 5),
        bonus: stars.has(index),
        ownerId: null,
        awardedPoints: 0
    }));
}

export function scoreStarfallClaim(board, index, uid) {
    if (!Array.isArray(board) || !Number.isInteger(index) || index < 0 || index >= board.length) {
        throw new Error("Bu kare tahtada bulunmuyor.");
    }
    const cell = board[index];
    if (!cell || cell.ownerId) throw new Error("Bu kare daha önce alındı.");

    const width = BOARD_SIZE;
    const row = Math.floor(index / width);
    const column = index % width;
    const neighbors = [
        row > 0 ? index - width : -1,
        row < width - 1 ? index + width : -1,
        column > 0 ? index - 1 : -1,
        column < width - 1 ? index + 1 : -1
    ].filter((neighbor) => neighbor >= 0 && board[neighbor]?.ownerId === uid).length;

    const connectionBonus = Math.min(2, neighbors) * 2;
    const starBonus = cell.bonus ? 3 : 0;
    return {
        basePoints: cell.value,
        connectionBonus,
        starBonus,
        totalPoints: cell.value + connectionBonus + starBonus,
        adjacentOwned: neighbors
    };
}

export function getNextStarfallPlayer(playerIds, turnsRemaining, currentIndex) {
    if (!Array.isArray(playerIds) || !playerIds.length) return null;
    for (let step = 1; step <= playerIds.length; step += 1) {
        const index = (currentIndex + step) % playerIds.length;
        const uid = playerIds[index];
        if (Number(turnsRemaining?.[uid]) > 0) return { uid, index };
    }
    return null;
}

export function getStarfallWinners(scores, playerIds) {
    const ids = Array.isArray(playerIds) ? playerIds : [];
    if (!ids.length) return [];
    const highest = Math.max(...ids.map((uid) => Number(scores?.[uid]) || 0));
    return ids.filter((uid) => (Number(scores?.[uid]) || 0) === highest);
}
