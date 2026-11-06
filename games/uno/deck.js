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

        for (const action of [
            ["skip", "skip"],
            ["reverse", "reverse"],
            ["draw2", "draw2"]
        ]) {
            cards.push(makeCard(color + "-" + action[0] + "-1", color, action[1], action[1]));
            cards.push(makeCard(color + "-" + action[0] + "-2", color, action[1], action[1]));
        }
    }

    for (let index = 1; index <= 4; index += 1) {
        cards.push(makeCard("wild-" + index, null, "wild", "wild"));
        cards.push(makeCard("wild4-" + index, null, "wild4", "wild4"));
    }

    return cards;
}

function randomIndex(max) {
    if (max <= 1) return 0;

    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === "function") {
        const buffer = new Uint32Array(1);
        globalThis.crypto.getRandomValues(buffer);
        return buffer[0] % max;
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
