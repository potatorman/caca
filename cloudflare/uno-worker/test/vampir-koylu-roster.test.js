import test from "node:test";
import assert from "node:assert/strict";

import { shouldRefreshUnconnectedRoster } from "../src/match-roster.js";

const validMissingPlayer = {
    role: "player",
    uid: "player-b",
    sessionPlayers: ["player-a", "player-b"],
    matchPlayerIds: ["player-a"],
    sessionStatus: "playing",
    matchStatus: "playing",
    hasAcceptedConnection: false,
    activeSocketCount: 0
};

test("refreshes a stale Worker roster before the first authorized player connects", () => {
    assert.equal(shouldRefreshUnconnectedRoster(validMissingPlayer), true);
});

test("never rebuilds a roster after a player has connected", () => {
    assert.equal(shouldRefreshUnconnectedRoster({
        ...validMissingPlayer,
        hasAcceptedConnection: true
    }), false);
    assert.equal(shouldRefreshUnconnectedRoster({
        ...validMissingPlayer,
        activeSocketCount: 1
    }), false);
});

test("does not refresh for spectators, removed players, or completed matches", () => {
    assert.equal(shouldRefreshUnconnectedRoster({
        ...validMissingPlayer,
        role: "spectator"
    }), false);
    assert.equal(shouldRefreshUnconnectedRoster({
        ...validMissingPlayer,
        sessionPlayers: ["player-a"]
    }), false);
    assert.equal(shouldRefreshUnconnectedRoster({
        ...validMissingPlayer,
        sessionStatus: "results"
    }), false);
});
