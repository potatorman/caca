import { UNO_COLORS, isCardPlayable } from "./engine.js";

const CARD_PRIORITY = Object.freeze({
    draw2: 6,
    skip: 5,
    reverse: 4,
    wild: 2,
    wild4: 1,
    number: 0
});

function pick(values, random) {
    if (!values.length) return null;
    const sample = Number(random());
    const fraction = Number.isFinite(sample) ? Math.max(0, Math.min(0.999999, sample)) : 0;
    return values[Math.floor(fraction * values.length)];
}

function countColors(cards) {
    const counts = Object.fromEntries(UNO_COLORS.map((color) => [color, 0]));
    for (const card of cards) {
        if (card?.color && Object.hasOwn(counts, card.color)) counts[card.color] += 1;
    }
    return counts;
}

function chooseColor(cards, random) {
    const counts = countColors(cards);
    const highest = Math.max(...UNO_COLORS.map((color) => counts[color]));
    return pick(UNO_COLORS.filter((color) => counts[color] === highest), random);
}

export function chooseUnoBotPlay(hand, topCard, activeColor, random = Math.random) {
    if (!Array.isArray(hand) || !hand.length) return null;
    const playable = hand.filter((card) => isCardPlayable(card, topCard, activeColor, hand));
    if (!playable.length) return null;

    const counts = countColors(hand);
    const ranked = playable.map((card) => ({
        card,
        score: (CARD_PRIORITY[card.type] ?? 0) +
            (card.color ? (counts[card.color] || 0) * 0.2 : 0) +
            (card.type === "number" ? (Number(card.value) || 0) * 0.02 : 0)
    }));
    const bestScore = Math.max(...ranked.map((item) => item.score));
    const card = pick(ranked.filter((item) => item.score === bestScore), random)?.card || null;
    if (!card) return null;

    const remaining = hand.filter((item) => item.id !== card.id);
    const selectedColor = card.type === "wild" || card.type === "wild4"
        ? chooseColor(remaining, random)
        : null;
    return { card, selectedColor };
}
