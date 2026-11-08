import test from "node:test";
import assert from "node:assert/strict";

import {
    chooseBotDoctorTarget,
    chooseBotVote,
    chooseBotVampireTarget,
    createBotDiscussionLine,
    createBotRoster
} from "../../../games/vampir-koylu/bots.js";

test("bot roster has stable round-scoped IDs and a unique display name per seat", () => {
    const roster = createBotRoster(5, 3);
    assert.equal(roster.length, 5);
    assert.equal(new Set(roster.map((bot) => bot.id)).size, 5);
    assert.equal(new Set(roster.map((bot) => bot.name)).size, 5);
    assert.ok(roster.every((bot) => bot.id.startsWith("bot-3-")));
    assert.deepEqual(createBotRoster(0, 1), []);
    assert.throws(() => createBotRoster(12, 1));
});

test("vampire bots coordinate on an existing teammate target", () => {
    const target = chooseBotVampireTarget({
        botId: "bot-vampire",
        alivePlayerIds: ["bot-vampire", "human-vampire", "doctor", "villager"],
        teammateIds: ["human-vampire"],
        vampireTargets: { "human-vampire": "villager" },
        random: () => 0
    });
    assert.equal(target, "villager");
});

test("a vampire bot never selects itself or a vampire teammate", () => {
    const target = chooseBotVampireTarget({
        botId: "bot-vampire",
        alivePlayerIds: ["bot-vampire", "human-vampire", "doctor", "villager"],
        teammateIds: ["human-vampire"],
        random: () => 0
    });
    assert.equal(target, "doctor");
});

test("doctor bots choose a living target and can avoid recent protections", () => {
    const target = chooseBotDoctorTarget({
        botId: "bot-doctor",
        alivePlayerIds: ["bot-doctor", "player-a", "player-b"],
        previousVictims: ["player-a"],
        random: () => 0.9
    });
    assert.equal(target, "player-b");
});

test("villager bots use public discussion accusations rather than hidden role data", () => {
    const target = chooseBotVote({
        botId: "bot-villager",
        role: "koylu",
        alivePlayerIds: ["bot-villager", "player-mert", "player-elif"],
        botNames: { "player-mert": "Mert", "player-elif": "Elif" },
        discussionMessages: [
            { text: "Mert çok şüpheli, vampir olabilir." },
            { text: "Bence Mert'in açıklaması tutarsız." }
        ],
        random: () => 0
    });
    assert.equal(target, "player-mert");
});

test("vampire bots follow a living vampire teammate's current vote", () => {
    const target = chooseBotVote({
        botId: "bot-vampire",
        role: "vampir",
        alivePlayerIds: ["bot-vampire", "other-vampire", "doctor", "villager"],
        vampireTeammateIds: ["other-vampire"],
        vampireVotes: { "other-vampire": "villager" },
        random: () => 0
    });
    assert.equal(target, "villager");
});

test("bot discussion lines are Turkish and do not expose the doctor's role", () => {
    const doctorLine = createBotDiscussionLine({
        role: "doktor",
        botId: "bot-doctor",
        playerIds: ["bot-doctor", "human"],
        random: () => 0
    });
    assert.ok(doctorLine.length > 10);
    assert.doesNotMatch(doctorLine.toLocaleLowerCase("tr"), /doktor|korumaya calis/);

    const vampireLine = createBotDiscussionLine({
        role: "vampir",
        botId: "bot-vampire",
        botNames: { human: "Mert" },
        playerIds: ["bot-vampire", "human"],
        random: () => 0
    });
    assert.match(vampireLine, /Mert/);

    const villagerLine = createBotDiscussionLine({
        role: "koylu",
        botId: "bot-villager",
        playerIds: ["bot-villager", "human"],
        random: () => 0
    });
    assert.ok(villagerLine.length > 10);
});
