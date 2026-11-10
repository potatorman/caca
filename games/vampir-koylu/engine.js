export const VAMPIR_KOYLU_ROLES = Object.freeze([
    "vampir",
    "doktor",
    "koylu"
]);

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 12;

export function getRoleCounts(playerCount) {
    if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
        throw new Error("Vampir Köylü 5–12 oyuncu ile oynanır.");
    }

    return {
        vampir: playerCount >= 8 ? 2 : 1,
        doktor: 1,
        koylu: playerCount - (playerCount >= 8 ? 2 : 1) - 1
    };
}

function shuffled(values, random = Math.random) {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
        const next = Math.floor(random() * (index + 1));
        [result[index], result[next]] = [result[next], result[index]];
    }
    return result;
}

export function assignRoles(playerIds, random = Math.random) {
    if (!Array.isArray(playerIds)) throw new Error("Oyuncu listesi geçersiz.");
    const players = [...new Set(playerIds.filter((id) => typeof id === "string" && id))];
    const counts = getRoleCounts(players.length);
    const order = shuffled(players, random);
    const roles = {};

    let cursor = 0;
    for (let index = 0; index < counts.vampir; index += 1) {
        roles[order[cursor++]] = "vampir";
    }
    roles[order[cursor++]] = "doktor";
    while (cursor < order.length) {
        roles[order[cursor++]] = "koylu";
    }

    return roles;
}

export function getWinningTeam(alivePlayerIds, roles) {
    const alive = [...new Set(Array.isArray(alivePlayerIds) ? alivePlayerIds : [])];
    const vampirCount = alive.filter((uid) => roles?.[uid] === "vampir").length;
    const koyluTeamCount = alive.length - vampirCount;

    if (vampirCount === 0) return "koyluler";
    if (vampirCount >= koyluTeamCount) return "vampirler";
    return null;
}

function getUniqueLeader(counts) {
    const entries = Object.entries(counts);
    if (!entries.length) return null;
    const highest = Math.max(...entries.map(([, count]) => count));
    const leaders = entries.filter(([, count]) => count === highest);
    return leaders.length === 1 ? leaders[0][0] : null;
}

export function resolveNight(vampireTargets, doctorTarget, alivePlayerIds, roles) {
    const alive = new Set(Array.isArray(alivePlayerIds) ? alivePlayerIds : []);
    const counts = {};

    for (const [vampireId, targetId] of Object.entries(vampireTargets || {})) {
        if (
            roles?.[vampireId] === "vampir" &&
            alive.has(vampireId) &&
            alive.has(targetId) &&
            roles?.[targetId] !== "vampir"
        ) {
            counts[targetId] = (counts[targetId] || 0) + 1;
        }
    }

    const targetUid = getUniqueLeader(counts);
    const vampireCount = [...alive].filter((uid) => roles?.[uid] === "vampir").length;
    const highestCount = Math.max(0, ...Object.values(counts));
    const requiredCount = Math.floor(vampireCount / 2) + 1;
    if (!targetUid) {
        return { victimUid: null, saved: false, tied: Object.keys(counts).length > 0 };
    }
    if (highestCount < requiredCount) {
        return { victimUid: null, saved: false, tied: false };
    }
    if (doctorTarget && alive.has(doctorTarget) && doctorTarget === targetUid) {
        return { victimUid: null, saved: true, savedUid: targetUid, tied: false };
    }
    return { victimUid: targetUid, saved: false, tied: false };
}

export function resolveVote(votes, alivePlayerIds) {
    const alive = new Set(Array.isArray(alivePlayerIds) ? alivePlayerIds : []);
    const counts = {};

    for (const [voterId, targetId] of Object.entries(votes || {})) {
        if (alive.has(voterId) && alive.has(targetId) && voterId !== targetId) {
            counts[targetId] = (counts[targetId] || 0) + 1;
        }
    }

    const targetUid = getUniqueLeader(counts);
    return {
        targetUid,
        tied: !targetUid && Object.keys(counts).length > 0,
        counts
    };
}
