import { UNO_COLORS } from "./deck.js";

export { UNO_COLORS };

export function hasColorCard(hand, color) {
    return Array.isArray(hand) && hand.some((card) =>
        card &&
        card.color === color &&
        card.type !== "wild" &&
        card.type !== "wild4"
    );
}

export function isCardPlayable(card, topCard, activeColor, hand = []) {
    if (!card || !topCard || !UNO_COLORS.includes(activeColor)) return false;
    if (card.type === "wild") return true;
    if (card.type === "wild4") return !hasColorCard(hand, activeColor);

    return card.color === activeColor || (
        card.type === topCard.type &&
        card.value === topCard.value
    );
}

export function nextPlayerIndex(index, direction, playerCount, steps = 1) {
    if (!Number.isInteger(playerCount) || playerCount < 1) {
        throw new Error("UNO en az bir aktif oyuncu gerektirir.");
    }
    if (!Number.isInteger(index) || !Number.isInteger(steps)) {
        throw new Error("UNO sıra indeksi geçersiz.");
    }

    const sign = direction === -1 ? -1 : 1;
    return ((index + sign * steps) % playerCount + playerCount) % playerCount;
}

export function getPlayEffect(card, playerCount, direction) {
    if (!card || !Number.isInteger(playerCount) || playerCount < 2) {
        throw new Error("UNO kart etkisi için oyuncu sayısı geçersiz.");
    }

    const sign = direction === -1 ? -1 : 1;
    switch (card.type) {
        case "skip":
            return { direction: sign, steps: 2, drawCount: 0, targetIndexOffset: 1 };
        case "reverse":
            return playerCount === 2
                ? { direction: sign, steps: 2, drawCount: 0, targetIndexOffset: 1 }
                : { direction: -sign, steps: 1, drawCount: 0, targetIndexOffset: 0 };
        case "draw2":
            return { direction: sign, steps: 2, drawCount: 2, targetIndexOffset: 1 };
        case "wild4":
            return { direction: sign, steps: 2, drawCount: 4, targetIndexOffset: 1 };
        default:
            return { direction: sign, steps: 1, drawCount: 0, targetIndexOffset: 0 };
    }
}
