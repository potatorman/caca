const BOT_NAMES = Object.freeze([
    "Mert", "Elif", "Zeynep", "Arda", "Ece", "Kerem",
    "Deniz", "Ada", "Bora", "Defne", "Can", "Selin"
]);

const NEUTRAL_LINES = Object.freeze([
    "Bence hemen oy vermeyelim. Herkes kimin şüpheli olduğunu anlatsın.",
    "Şu an kesin konuşmak zor. Önce birbirimizi dinleyelim.",
    "Dün gece olanları düşününce birkaç kişiyi daha yakından izlemek gerekiyor.",
    "Bence herkes oyunu neden verdiğini de açıklasın.",
    "Sessiz kalmak tek başına kanıt değil ama konuşmaları takip edelim.",
    "Birbirimizi suçlamadan önce elimizdeki bilgileri değerlendirelim."
]);

const VAMPIRE_LINES = Object.freeze([
    "{name} bana biraz şüpheli geliyor. Nedenini açıklarsa iyi olur.",
    "Bence dikkatimizi {name} üzerine çevirmeliyiz.",
    "{name} hakkındaki konuşmalar bana pek inandırıcı gelmedi.",
    "Şu an {name} üzerinde durmak mantıklı olabilir."
]);

const DOCTOR_LINES = Object.freeze([
    "Şu an kesin konuşmak zor. Önce birbirimizi dinleyelim.",
    "Kimin ne söylediğini takip ediyorum. Biraz daha bilgiye ihtiyacımız var.",
    "Herkes şüphelendiği kişiyi söylesin; tek bir iddiayla karar vermeyelim."
]);

function pick(values, random = Math.random) {
    if (!values.length) return null;
    return values[Math.floor(random() * values.length)];
}

function normalizeText(value) {
    return String(value || "")
        .toLocaleLowerCase("tr")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function scorePublicAccusations(candidateId, botNames, discussionMessages) {
    const candidateName = botNames?.[candidateId];
    if (!candidateName) return 0;

    const needle = normalizeText(candidateName);
    let score = 0;

    for (const message of discussionMessages || []) {
        const text = normalizeText(message?.text);
        if (!text.includes(needle)) continue;
        if (/vampir|supheli|guvenm|inanmiyorum|oyum|saldir|suclu/.test(text)) {
            score += 1;
        }
    }

    return score;
}

export function createBotRoster(count, round = 1) {
    if (!Number.isInteger(count) || count < 0 || count > 11) {
        throw new Error("Bot sayısı 0–11 arasında olmalı.");
    }

    return Array.from({ length: count }, (_, index) => {
        const id = "bot-" + round + "-" + (index + 1);
        return {
            id,
            name: BOT_NAMES[(index + round - 1) % BOT_NAMES.length]
        };
    });
}

export function chooseBotVampireTarget({
    botId,
    alivePlayerIds,
    teammateIds = [],
    vampireTargets = {},
    random = Math.random
}) {
    const alive = new Set(alivePlayerIds || []);
    const teammateSet = new Set(teammateIds);
    const existingTargets = Object.entries(vampireTargets || {})
        .filter(([vampireId, targetId]) =>
            alive.has(vampireId) &&
            teammateSet.has(vampireId) &&
            alive.has(targetId)
        )
        .map(([, targetId]) => targetId);

    if (existingTargets.length) return existingTargets[0];

    const candidates = (alivePlayerIds || []).filter((id) =>
        id !== botId && !teammateSet.has(id)
    );
    return pick(candidates, random);
}

export function chooseBotDoctorTarget({
    botId,
    alivePlayerIds,
    previousVictims = [],
    random = Math.random
}) {
    const alive = alivePlayerIds || [];
    if (!alive.length) return null;

    // A doctor occasionally protects themself. Otherwise, avoid repeating
    // last night's protection and spread protection across living players.
    if (alive.includes(botId) && random() < 0.22) return botId;

    const previouslyProtected = new Set(previousVictims);
    const fresh = alive.filter((id) => id !== botId && !previouslyProtected.has(id));
    const alternatives = alive.filter((id) => id !== botId);
    return pick(fresh.length ? fresh : alternatives.length ? alternatives : alive, random);
}

export function chooseBotVote({
    botId,
    role,
    alivePlayerIds,
    vampireTeammateIds = [],
    vampireVotes = {},
    botNames = {},
    discussionMessages = [],
    voteHistory = [],
    revealedRoles = {},
    random = Math.random
}) {
    const alive = (alivePlayerIds || []).filter((id) => id !== botId);
    if (!alive.length) return null;

    if (role === "vampir") {
        const teammateSet = new Set(vampireTeammateIds);
        const coordinated = Object.entries(vampireVotes)
            .find(([voterId, targetId]) =>
                teammateSet.has(voterId) && alive.includes(targetId)
            );
        if (coordinated) return coordinated[1];

        const candidates = alive.filter((id) => !teammateSet.has(id));
        return pick(candidates.length ? candidates : alive, random);
    }

    // Non-vampire bots only inspect public discussion and revealed information.
    // Their decision never receives or reads the hidden role map.
    const scores = new Map(alive.map((id) => [
        id,
        scorePublicAccusations(id, botNames, discussionMessages)
    ]));

    for (const day of voteHistory || []) {
        for (const [voterId, targetId] of Object.entries(day?.votes || {})) {
            if (
                voterId === botId &&
                scores.has(targetId) &&
                revealedRoles[targetId] &&
                revealedRoles[targetId] !== "vampir"
            ) {
                scores.set(targetId, scores.get(targetId) + 1);
            }
            if (
                scores.has(voterId) &&
                revealedRoles[targetId] &&
                revealedRoles[targetId] !== "vampir"
            ) {
                scores.set(voterId, scores.get(voterId) + 0.5);
            }
        }
    }

    const highest = Math.max(...scores.values());
    const strongest = alive.filter((id) => scores.get(id) === highest);
    return pick(strongest, random);
}

export function createBotDiscussionLine({
    role,
    botId,
    botNames = {},
    playerIds = [],
    vampireTeammateIds = [],
    discussionMessages = [],
    random = Math.random
}) {
    if (role === "vampir") {
        const candidates = playerIds.filter((id) =>
            id !== botId &&
            !vampireTeammateIds.includes(id)
        );
        const target = pick(candidates, random);
        const name = botNames[target] || "bir oyuncu";
        return pick(VAMPIRE_LINES, random).replaceAll("{name}", name);
    }

    if (role === "doktor") return pick(DOCTOR_LINES, random);
    return pick(NEUTRAL_LINES, random);
}
