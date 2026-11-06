import { UNO_COLORS } from "./deck.js";

export { UNO_COLORS };

export function isWildCard(card) {
    return card?.type === "wild" || card?.type === "wild4";
}

export function hasColorCard(hand, color) {
    return Array.isArray(hand) && hand.some((card) =>
        card && card.color === color && card.type !== "wild" && card.type !== "wild4"
    );
}

export function isCardPlayable(card, topCard, activeColor, hand) {
    if (!card || !topCard || !UNO_COLORS.includes(activeColor)) return false;

    if (card.type === "wild") return true;

    if (card.type === "wild4") {
        return !hasColorCard(hand, activeColor);
    }

    return card.color === activeColor || (
        card.type === topCard.type && card.value === topCard.value
    );
}

export function nextPlayerIndex(index, direction, playerCount, steps = 1) {
    if (!Number.isInteger(playerCount) || playerCount < 1) {
        throw new Error("UNO en az bir aktif oyuncu gerektirir.");
    }

    const normalizedDirection = direction === -1 ? -1 : 1;
    return ((index + normalizedDirection * steps) % playerCount + playerCount) % playerCount;
}

export function getPlayEffect(card, playerCount, direction) {
    if (card.type === "skip") {
        return { direction, steps: 2, drawCount: 0, targetIndexOffset: 1 };
    }

    if (card.type === "reverse") {
        if (playerCount === 2) {
            return { direction, steps: 2, drawCount: 0, targetIndexOffset: 1 };
        }

        const nextDirection = direction * -1;
        return { direction: nextDirection, steps: 1, drawCount: 0, targetIndexOffset: 0 };
    }

    if (card.type === "draw2") {
        return { direction, steps: 2, drawCount: 2, targetIndexOffset: 1 };
    }

    if (card.type === "wild4") {
        return { direction, steps: 2, drawCount: 4, targetIndexOffset: 1 };
    }

    return { direction, steps: 1, drawCount: 0, targetIndexOffset: 0 };
}
