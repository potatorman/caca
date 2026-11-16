import test from "node:test";
import assert from "node:assert/strict";

import {
    advancePuzzleRound,
    allPlayersAnswered,
    applyPuzzleAnswer,
    createPuzzleMatch,
    MAX_PUZZLE_PLAYERS,
    QUESTION_TIME_MS,
    revealPuzzleRound,
    scorePuzzleAnswer
} from "../../../games/puzzle/engine.js";
import { getPuzzlePack, getPublicQuestion, PUZZLE_GAME_IDS } from "../../../games/puzzle/questions.js";

test("both original games expose eight valid, unique, four-choice questions", () => {
    assert.deepEqual([...PUZZLE_GAME_IDS].sort(), ["odd-signal", "pattern-party"]);
    for (const gameId of PUZZLE_GAME_IDS) {
        const pack = getPuzzlePack(gameId);
        assert.equal(pack.length, 8);
        assert.equal(new Set(pack.map((question) => question.id)).size, 8);
        for (let index = 0; index < pack.length; index += 1) {
            const question = pack[index];
            assert.equal(question.options.length, 4);
            assert.ok(Number.isInteger(question.answer));
            assert.ok(question.answer >= 0 && question.answer < question.options.length);
            assert.ok(question.prompt.length > 10);
            assert.ok(question.explanation.length > 10);
            const publicQuestion = getPublicQuestion(gameId, index);
            assert.equal("answer" in publicQuestion, false);
            assert.equal("explanation" in publicQuestion, false);
        }
    }
});

test("match creation de-duplicates players and enforces the 2–8 player range", () => {
    const match = createPuzzleMatch({
        roomId: "global",
        lobbyId: "lobby-1234567890123456",
        round: 1,
        gameId: "odd-signal",
        playerIds: ["a", "a", "b"],
        now: 1000,
        random: () => 0.5
    });
    assert.deepEqual(match.playerIds, ["a", "b"]);
    assert.equal(match.status, "playing");
    assert.equal(match.phase, "question");
    assert.equal(match.questionOrder.length, 8);
    assert.equal(new Set(match.questionOrder).size, 8);
    assert.equal(match.phaseEndsAt, 1000 + QUESTION_TIME_MS);
    assert.throws(() => createPuzzleMatch({
        roomId: "global", lobbyId: "lobby", round: 1,
        gameId: "odd-signal", playerIds: ["solo"]
    }), /2–8/);
    assert.throws(() => createPuzzleMatch({
        roomId: "global", lobbyId: "lobby", round: 1,
        gameId: "odd-signal",
        playerIds: Array.from({ length: MAX_PUZZLE_PLAYERS + 1 }, (_, i) => "p" + i)
    }), /2–8/);
});

test("correct answers reward accuracy, speed and capped streaks; wrong answers reset streak", () => {
    assert.deepEqual(scorePuzzleAnswer({ correct: false, elapsedMs: 20, previousStreak: 3 }), {
        points: 0, streak: 0, speedBonus: 0, streakBonus: 0
    });
    const immediate = scorePuzzleAnswer({ correct: true, elapsedMs: 0, previousStreak: 0 });
    assert.deepEqual(immediate, { points: 140, streak: 1, speedBonus: 40, streakBonus: 0 });
    const capped = scorePuzzleAnswer({ correct: true, elapsedMs: QUESTION_TIME_MS, previousStreak: 99 });
    assert.deepEqual(capped, { points: 140, streak: 100, speedBonus: 0, streakBonus: 40 });
});

test("answers are server-scored once per player and hidden until reveal", () => {
    const match = createPuzzleMatch({
        roomId: "global", lobbyId: "lobby-1234567890123456",
        round: 1, gameId: "pattern-party", playerIds: ["a", "b", "c"], now: 500
    });
    const question = getPuzzlePack(match.gameId)[match.questionOrder[0]];
    const score = applyPuzzleAnswer(match, "a", question.answer, 1500);
    assert.equal(score.correct, true);
    assert.ok(score.points >= 100);
    assert.equal(allPlayersAnswered(match), false);
    assert.equal(match.answers.a.optionIndex, question.answer);
    assert.equal(match.answers.a.correct, true);
    assert.equal(match.scores.a, score.points);
    assert.throws(() => applyPuzzleAnswer(match, "a", question.answer, 1600), /zaten gönderdin/);
    assert.throws(() => applyPuzzleAnswer(match, "not-a-player", question.answer, 1600), /aktif oyuncusu/);
    assert.equal("revealedAnswer" in match, false);
    applyPuzzleAnswer(match, "b", (question.answer + 1) % 4, 1700);
    applyPuzzleAnswer(match, "c", question.answer, 1800);
    assert.equal(allPlayersAnswered(match), true);
    revealPuzzleRound(match, 1900);
    assert.equal(match.phase, "reveal");
    assert.equal(match.revealedAnswer, question.answer);
    assert.equal(match.answers.b.correct, false);
});

test("the authoritative deadline rejects late answers and reveal marks missed players wrong", () => {
    const match = createPuzzleMatch({
        roomId: "global", lobbyId: "lobby-1234567890123456",
        round: 1, gameId: "odd-signal", playerIds: ["a", "b"], now: 1000
    });
    const question = getPuzzlePack(match.gameId)[match.questionOrder[0]];
    assert.throws(() => applyPuzzleAnswer(
        match, "a", question.answer, match.phaseEndsAt
    ), /süresi sona erdi/i);
    assert.equal(revealPuzzleRound(match, match.phaseEndsAt + 20), true);
    assert.equal(match.phase, "reveal");
    assert.equal(match.answers.a.correct, false);
    assert.equal(match.answers.b.optionIndex, null);
    assert.equal(match.scores.a, 0);
    assert.equal(match.streaks.a, 0);
});

test("eight complete rounds produce a deterministic winner or a tie", () => {
    const match = createPuzzleMatch({
        roomId: "global", lobbyId: "lobby-1234567890123456",
        round: 1, gameId: "pattern-party", playerIds: ["a", "b"], now: 10_000
    });
    for (let round = 0; round < 8; round += 1) {
        const question = getPuzzlePack(match.gameId)[match.questionOrder[match.roundIndex]];
        for (const uid of match.activePlayerIds) {
            applyPuzzleAnswer(match, uid, question.answer, match.phaseStartedAt + 1000);
        }
        assert.equal(allPlayersAnswered(match), true);
        revealPuzzleRound(match, match.phaseStartedAt + 1500);
        assert.equal(advancePuzzleRound(match, match.phaseEndsAt), true);
    }
    assert.equal(match.status, "results");
    assert.equal(match.phase, "results");
    assert.equal(match.roundIndex, 7);
    assert.equal(match.winnerIds.length, 2);
    assert.equal(match.scores.a, match.scores.b);
    assert.ok(match.finishedAt > 0);
});

test("a game with up to eight players tracks independent scores and submissions", () => {
    const players = Array.from({ length: 8 }, (_, index) => "player-" + index);
    const match = createPuzzleMatch({
        roomId: "global", lobbyId: "lobby-1234567890123456",
        round: 1, gameId: "odd-signal", playerIds: players, now: 50
    });
    const question = getPuzzlePack(match.gameId)[match.questionOrder[0]];
    players.forEach((uid, index) => {
        applyPuzzleAnswer(match, uid, index % 2 === 0 ? question.answer : (question.answer + 1) % 4, 1000 + index);
    });
    assert.equal(allPlayersAnswered(match), true);
    assert.equal(Object.keys(match.answers).length, 8);
    assert.equal(match.scores["player-0"] > 0, true);
    assert.equal(match.scores["player-1"], 0);
});
