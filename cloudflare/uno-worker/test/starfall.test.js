import test from "node:test";
import assert from "node:assert/strict";
import {
    BOARD_CELLS,
    BOARD_SIZE,
    MAX_PLAYERS,
    TURNS_PER_PLAYER,
    createStarfallBoard,
    scoreStarfallClaim,
    getNextStarfallPlayer,
    getStarfallWinners
} from "../../../games/starfall/engine.js";

test("Starfall board has 36 valid cells and six unique star bonuses", () => {
    let seed = 0;
    const random = () => ((seed++ * 17) % 101) / 101;
    const board = createStarfallBoard(random);
    assert.equal(board.length, BOARD_CELLS);
    assert.equal(BOARD_CELLS, BOARD_SIZE * BOARD_SIZE);
    assert.equal(board.filter((cell) => cell.bonus).length, 6);
    assert.ok(board.every((cell, index) =>
        cell.index === index && cell.value >= 1 && cell.value <= 5 &&
        cell.ownerId === null && cell.awardedPoints === 0
    ));
});

test("claim scoring rewards a star and up to two connected cells", () => {
    const board = Array.from({ length: BOARD_CELLS }, (_, index) => ({
        index, value: 2, bonus: false, ownerId: null, awardedPoints: 0
    }));
    board[0].ownerId = "p1";
    board[1].ownerId = "p1";
    board[2].bonus = true;
    const score = scoreStarfallClaim(board, 2, "p1");
    assert.equal(score.basePoints, 2);
    assert.equal(score.connectionBonus, 2);
    assert.equal(score.starBonus, 3);
    assert.equal(score.totalPoints, 7);
    assert.equal(score.adjacentOwned, 1);
});

test("claims reject occupied and out-of-range cells", () => {
    const board = createStarfallBoard(() => 0.25);
    board[0].ownerId = "p1";
    assert.throws(() => scoreStarfallClaim(board, 0, "p2"), /daha önce alındı/);
    assert.throws(() => scoreStarfallClaim(board, 99, "p2"), /tahtada bulunmuyor/);
});

test("turn rotation skips players whose four turns are used or who leave", () => {
    assert.equal(TURNS_PER_PLAYER, 4);
    assert.equal(MAX_PLAYERS, 8);
    const players = ["p1", "p2", "p3", "p4"];
    const left = { p1: 0, p2: 2, p3: 0, p4: 1 };
    assert.deepEqual(getNextStarfallPlayer(players, left, 0), { uid: "p2", index: 1 });
    left.p2 = 0;
    assert.deepEqual(getNextStarfallPlayer(players, left, 1), { uid: "p4", index: 3 });
    left.p4 = 0;
    assert.equal(getNextStarfallPlayer(players, left, 3), null);
});

test("all tied top scores are returned as co-winners", () => {
    assert.deepEqual(getStarfallWinners({ p1: 10, p2: 8, p3: 10 }, ["p1", "p2", "p3"]), ["p1", "p3"]);
    assert.deepEqual(getStarfallWinners({}, ["p1", "p2"]), ["p1", "p2"]);
    assert.deepEqual(getStarfallWinners({}, []), []);
});
