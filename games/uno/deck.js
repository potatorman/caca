export const UNO_COLORS = Object.freeze(["red", "yellow", "green", "blue"]);

function makeCard(id, color, type, value) {
    return Object.freeze({ id, color, type, value });
}

export function createUnoDeck() {
    const cards = [];

    for (const color of UNO_COLORS) {
        cards.push(makeCard(color + "-0-1", color, "number", "0"));

        for (let number = 1; number <= 9; number += 1) {
            cards.push(makeCard(color + "-" + number + "-1", color, "number", String(number)));
            cards.push(makeCard(color + "-" + number + "-2", color, "number", String(number)));
        }

        for (const [suffix, type] of [
            ["skip", "skip"],
            ["reverse", "reverse"],
            ["draw2", "draw2"]
        ]) {
            cards.push(makeCard(color + "-" + suffix + "-1", color, type, type));
            cards.push(makeCard(color + "-" + suffix + "-2", color, type, type));
        }
    }

    for (let index = 1; index <= 4; index += 1) {
        cards.push(makeCard("wild-" + index, null, "wild", "wild"));
        cards.push(makeCard("wild4-" + index, null, "wild4", "wild4"));
    }

    return cards;
}

function randomIndex(max) {
    if (!Number.isInteger(max) || max <= 1) return 0;

    if (globalThis.crypto?.getRandomValues) {
        const range = 0x1_0000_0000;
        const limit = Math.floor(range / max) * max;
        const values = new Uint32Array(1);

        do {
            globalThis.crypto.getRandomValues(values);
        } while (values[0] >= limit);

        return values[0] % max;
    }

    return Math.floor(Math.random() * max);
}

export function shuffleDeck(cards) {
    const shuffled = [...cards];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const target = randomIndex(index + 1);
        [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
    }
    return shuffled;
}
