import test from "node:test";
import assert from "node:assert/strict";

import { createGameBotRoster } from "../../../games/bot-roster.js";
import { chooseUnoBotPlay } from "../../../games/uno/bots.js";
import { chooseStarfallBotMove } from "../../../games/starfall/bots.js";

test("UNO bot filling creates server-side seats up to the selected total", () => {
    const roster = createGameBotRoster("uno", ["human-1"], {
        botFillEnabled: true, targetPlayerCount: 4
    }, 3);
    assert.equal(roster.playerIds.length, 4);
    assert.deepEqual(roster.humanPlayerIds, ["human-1"]);
    assert.equal(roster.botPlayerIds.length, 3);
    assert.equal(new Set(roster.playerIds).size, 4);
    assert.equal(roster.botNames[roster.botPlayerIds[0]].endsWith("· Bot"), true);
    assert.equal(roster.botPlayerIds.every((id) => id.startsWith("bot-uno-3-")), true);
});

test("Starfall bot filling respects the eight-player cap", () => {
    const roster = createGameBotRoster("starfall", ["human-1", "human-2"], {
        botFillEnabled: true, targetPlayerCount: 8
    }, 1);
    assert.equal(roster.playerIds.length, 8);
    assert.equal(roster.botPlayerIds.length, 6);
    assert.throws(() => createGameBotRoster("starfall", ["human-1"], {
        botFillEnabled: true, targetPlayerCount: 9
    }, 1));
});

test("bot filling disabled keeps the game's real-player minimum", () => {
    assert.throws(() => createGameBotRoster("uno", ["human-1"], {
        botFillEnabled: false, targetPlayerCount: 2
    }, 1));
    const roster = createGameBotRoster("uno", ["one", "two"], {
        botFillEnabled: false, targetPlayerCount: 2
    }, 1);
    assert.equal(roster.botPlayerIds.length, 0);
});

test("UNO bot chooses a playable action card", () => {
    const hand = [
        { id: "red-3", color: "red", type: "number", value: "3" },
        { id: "red-draw2", color: "red", type: "draw2", value: "draw2" },
        { id: "wild-1", color: null, type: "wild", value: "wild" }
    ];
    const choice = chooseUnoBotPlay(
        hand, { id: "red-7", color: "red", type: "number", value: "7" }, "red", () => 0
    );
    assert.equal(choice.card.id, "red-draw2");
    assert.equal(choice.selectedColor, null);
});

test("UNO bot selects its strongest remaining color for wild cards", () => {
    const hand = [
        { id: "wild-1", color: null, type: "wild", value: "wild" },
        { id: "blue-1", color: "blue", type: "number", value: "1" },
        { id: "blue-2", color: "blue", type: "number", value: "2" },
        { id: "green-3", color: "green", type: "number", value: "3" }
    ];
    const choice = chooseUnoBotPlay(
        hand, { id: "red-7", color: "red", type: "number", value: "7" }, "red", () => 0
    );
    assert.equal(choice.card.id, "wild-1");
    assert.equal(choice.selectedColor, "blue");
});

test("UNO bot passes when no card is playable", () => {
    const hand = [{ id: "blue-2", color: "blue", type: "number", value: "2" }];
    assert.equal(chooseUnoBotPlay(
        hand, { id: "red-7", color: "red", type: "number", value: "7" }, "red", () => 0
    ), null);
});

test("Starfall bot claims the highest-value available square", () => {
    const board = Array.from({ length: 36 }, (_, index) => ({
        index, value: 1, bonus: false, ownerId: null, awardedPoints: 0
    }));
    board[17].value = 2;
    board[17].bonus = true;
    board[30].value = 5;
    assert.equal(chooseStarfallBotMove(board, "bot-starfall", () => 0), 17);
});

test("Starfall bot returns null when no square remains", () => {
    const board = Array.from({ length: 36 }, (_, index) => ({
        index, value: 1, bonus: false, ownerId: "human", awardedPoints: 1
    }));
    assert.equal(chooseStarfallBotMove(board, "bot-starfall"), null);
});
