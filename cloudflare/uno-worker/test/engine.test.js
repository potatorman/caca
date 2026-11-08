import test from "node:test";
import assert from "node:assert/strict";

import { createUnoDeck, shuffleDeck } from "../../../games/uno/deck.js";
import {
    UNO_COLORS,
    getPlayEffect,
    isCardPlayable,
    nextPlayerIndex
} from "../../../games/uno/engine.js";

test("UNO deck contains 108 unique cards", () => {
    const deck = createUnoDeck();
    assert.equal(deck.length, 108);
    assert.equal(new Set(deck.map((card) => card.id)).size, 108);
    assert.equal(deck.filter((card) => card.type === "number").length, 76);
    assert.equal(deck.filter((card) => card.type === "skip").length, 8);
    assert.equal(deck.filter((card) => card.type === "reverse").length, 8);
    assert.equal(deck.filter((card) => card.type === "draw2").length, 8);
    assert.equal(deck.filter((card) => card.type === "wild").length, 4);
    assert.equal(deck.filter((card) => card.type === "wild4").length, 4);
});

test("shuffle produces a complete deck without mutating the source", () => {
    const deck = createUnoDeck();
    const originalOrder = deck.map((card) => card.id);
    const shuffled = shuffleDeck(deck);

    assert.equal(shuffled.length, deck.length);
    assert.deepEqual(new Set(shuffled.map((card) => card.id)), new Set(originalOrder));
    assert.deepEqual(deck.map((card) => card.id), originalOrder);
});

test("normal cards match by color or symbol", () => {
    const top = { id: "red-5-1", color: "red", type: "number", value: "5" };
    assert.equal(isCardPlayable(
        { id: "red-8-1", color: "red", type: "number", value: "8" },
        top, "red"
    ), true);
    assert.equal(isCardPlayable(
        { id: "blue-5-1", color: "blue", type: "number", value: "5" },
        top, "red"
    ), true);
    assert.equal(isCardPlayable(
        { id: "blue-8-1", color: "blue", type: "number", value: "8" },
        top, "red"
    ), false);
});

test("wild cards are playable and Wild Draw Four respects the active color restriction", () => {
    const top = { id: "red-2-1", color: "red", type: "number", value: "2" };
    assert.equal(isCardPlayable(
        { id: "wild-1", color: null, type: "wild", value: "wild" },
        top, "red"
    ), true);
    const wild4 = { id: "wild4-1", color: null, type: "wild4", value: "wild4" };
    assert.equal(isCardPlayable(wild4, top, "red", [
        { id: "red-7-1", color: "red", type: "number", value: "7" }
    ]), false);
    assert.equal(isCardPlayable(wild4, top, "red", [
        { id: "blue-7-1", color: "blue", type: "number", value: "7" }
    ]), true);
});

test("turn order handles clockwise, counter-clockwise and wrapped indexes", () => {
    assert.equal(nextPlayerIndex(0, 1, 4), 1);
    assert.equal(nextPlayerIndex(3, 1, 4), 0);
    assert.equal(nextPlayerIndex(0, -1, 4), 3);
    assert.equal(nextPlayerIndex(0, 1, 2, 2), 0);
    assert.throws(() => nextPlayerIndex(0, 1, 0));
});

test("Skip, Draw Two, Wild Draw Four and Reverse apply the correct turn effects", () => {
    assert.deepEqual(getPlayEffect(
        { type: "skip" }, 4, 1
    ), { direction: 1, steps: 2, drawCount: 0, targetIndexOffset: 1 });
    assert.deepEqual(getPlayEffect(
        { type: "draw2" }, 4, 1
    ), { direction: 1, steps: 2, drawCount: 2, targetIndexOffset: 1 });
    assert.deepEqual(getPlayEffect(
        { type: "wild4" }, 4, 1
    ), { direction: 1, steps: 2, drawCount: 4, targetIndexOffset: 1 });
    assert.deepEqual(getPlayEffect(
        { type: "reverse" }, 4, 1
    ), { direction: -1, steps: 1, drawCount: 0, targetIndexOffset: 0 });
    assert.deepEqual(getPlayEffect(
        { type: "reverse" }, 2, 1
    ), { direction: 1, steps: 2, drawCount: 0, targetIndexOffset: 1 });
});

test("color list contains exactly the four UNO colors", () => {
    assert.deepEqual(UNO_COLORS, ["red", "yellow", "green", "blue"]);
});
