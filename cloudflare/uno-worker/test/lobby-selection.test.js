import test from "node:test";
import assert from "node:assert/strict";
import { selectGameLobbyForUser } from "../../../games/lobby-selection.js";

const lobby = (id, fields = {}) => ({
    lobbyId: id,
    status: "lobby",
    hostId: "host-" + id,
    playerIds: ["host-" + id],
    ...fields
});

test("a non-member does not automatically open another user's active lobby", () => {
    const sessions = new Map([["a", lobby("a")]]);
    const result = selectGameLobbyForUser(sessions, "unrelated-user");
    assert.equal(result.selectedSession, null);
    assert.equal(result.joinedActiveLobby, null);
});

test("the host automatically opens their own lobby", () => {
    const sessions = new Map([["a", lobby("a")]]);
    const result = selectGameLobbyForUser(sessions, "host-a");
    assert.equal(result.selectedSession.lobbyId, "a");
    assert.equal(result.ownedActiveLobby.lobbyId, "a");
});

test("a joined player or spectator automatically opens the lobby they belong to", () => {
    const sessions = new Map([
        ["a", lobby("a")],
        ["b", lobby("b", { spectatorIds: ["spectator"] })]
    ]);
    assert.equal(selectGameLobbyForUser(sessions, "spectator").selectedSession.lobbyId, "b");
    const playerSessions = new Map([["a", lobby("a", { playerIds: ["host-a", "player"] })]]);
    assert.equal(selectGameLobbyForUser(playerSessions, "player").selectedSession.lobbyId, "a");
});

test("a deliberate lobby selection remains visible for a non-member to join", () => {
    const sessions = new Map([["a", lobby("a")]]);
    const result = selectGameLobbyForUser(sessions, "unrelated-user", "a");
    assert.equal(result.selectedSession.lobbyId, "a");
});

test("a stale or closed explicit selection is not retained", () => {
    const sessions = new Map([["a", lobby("a", { status: "closed" })]]);
    assert.equal(selectGameLobbyForUser(sessions, "unrelated-user", "a").selectedSession, null);
});
