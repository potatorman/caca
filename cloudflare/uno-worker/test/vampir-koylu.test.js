import test from "node:test";
import assert from "node:assert/strict";

import {
    MIN_PLAYERS,
    MAX_PLAYERS,
    assignRoles,
    getRoleCounts,
    getWinningTeam,
    resolveNight,
    resolveVote
} from "../../../games/vampir-koylu/engine.js";

test("Vampir Köylü supports 5–12 players and rejects invalid lobby sizes", () => {
    assert.equal(MIN_PLAYERS, 5);
    assert.equal(MAX_PLAYERS, 12);
    assert.throws(() => getRoleCounts(4));
    assert.throws(() => getRoleCounts(13));
});

test("role distribution is one vampire through seven players and two from eight", () => {
    assert.deepEqual(getRoleCounts(5), { vampir: 1, doktor: 1, koylu: 3 });
    assert.deepEqual(getRoleCounts(7), { vampir: 1, doktor: 1, koylu: 5 });
    assert.deepEqual(getRoleCounts(8), { vampir: 2, doktor: 1, koylu: 5 });
    assert.deepEqual(getRoleCounts(12), { vampir: 2, doktor: 1, koylu: 9 });
});

test("role assignment gives every player exactly one hidden role", () => {
    const players = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const roles = assignRoles(players, () => 0.42);

    assert.equal(Object.keys(roles).length, 8);
    assert.equal(Object.values(roles).filter((role) => role === "vampir").length, 2);
    assert.equal(Object.values(roles).filter((role) => role === "doktor").length, 1);
    assert.equal(Object.values(roles).filter((role) => role === "koylu").length, 5);
    assert.ok(Object.keys(roles).every((uid) => players.includes(uid)));
});

test("villagers win when the last vampire is eliminated", () => {
    assert.equal(getWinningTeam(["doctor", "villager"], {
        doctor: "doktor",
        villager: "koylu",
        vampire: "vampir"
    }), "koyluler");
});

test("vampires win when their count reaches parity with the remaining village", () => {
    assert.equal(getWinningTeam(["v1", "doctor"], {
        v1: "vampir",
        doctor: "doktor",
        villager: "koylu"
    }), "vampirler");
    assert.equal(getWinningTeam(["v1", "v2", "doctor", "villager"], {
        v1: "vampir",
        v2: "vampir",
        doctor: "doktor",
        villager: "koylu"
    }), "vampirler");
});

test("doctor saves the majority vampire target", () => {
    const result = resolveNight(
        { v1: "villager", v2: "villager" },
        "villager",
        ["v1", "v2", "doctor", "villager"],
        { v1: "vampir", v2: "vampir", doctor: "doktor", villager: "koylu" }
    );
    assert.deepEqual(result, {
        victimUid: null,
        saved: true,
        savedUid: "villager",
        tied: false
    });
});

test("two vampires need a majority target; one missing action is not enough", () => {
    const result = resolveNight(
        { v1: "villager" },
        null,
        ["v1", "v2", "doctor", "villager"],
        { v1: "vampir", v2: "vampir", doctor: "doktor", villager: "koylu" }
    );
    assert.deepEqual(result, { victimUid: null, saved: false, tied: false });
});

test("night target ties cause no elimination", () => {
    const result = resolveNight(
        { v1: "villager", v2: "doctor" },
        null,
        ["v1", "v2", "doctor", "villager"],
        { v1: "vampir", v2: "vampir", doctor: "doktor", villager: "koylu" }
    );
    assert.deepEqual(result, { victimUid: null, saved: false, tied: true });
});

test("vampires cannot use targets that are themselves or fellow vampires", () => {
    const result = resolveNight(
        { v1: "v2", v2: "v1" },
        null,
        ["v1", "v2", "doctor", "villager"],
        { v1: "vampir", v2: "vampir", doctor: "doktor", villager: "koylu" }
    );
    assert.deepEqual(result, { victimUid: null, saved: false, tied: false });
});

test("voting requires a unique highest target; ties do not eliminate anyone", () => {
    assert.deepEqual(
        resolveVote({ a: "b", b: "a", c: "b" }, ["a", "b", "c"]),
        { targetUid: "b", tied: false, counts: { b: 2, a: 1 } }
    );
    assert.deepEqual(
        resolveVote({ a: "b", b: "a" }, ["a", "b"]),
        { targetUid: null, tied: true, counts: { b: 1, a: 1 } }
    );
});

test("dead players and self-votes are ignored", () => {
    assert.deepEqual(
        resolveVote({ a: "a", dead: "b" }, ["a", "b"]),
        { targetUid: null, tied: false, counts: {} }
    );
});
