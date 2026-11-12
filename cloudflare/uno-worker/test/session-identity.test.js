import test from "node:test";
import assert from "node:assert/strict";

import {
    getUnoDurableObjectName,
    getVampirKoyluDurableObjectName,
    isValidLobbyId,
    isValidVampirKoyluSessionId,
    matchesVampirKoyluSession
} from "../src/session-identity.js";

test("lobby IDs are validated and distinct tables get distinct UNO Durable Objects", () => {
    const firstLobby = "0123456789abcdef0123456789abcdef";
    const secondLobby = "fedcba9876543210fedcba9876543210";
    assert.equal(isValidLobbyId(firstLobby), true);
    assert.equal(isValidLobbyId("short"), false);
    assert.notEqual(getUnoDurableObjectName("room-123", firstLobby, 1), getUnoDurableObjectName("room-123", secondLobby, 1));
    assert.equal(getUnoDurableObjectName("room-123", firstLobby, 1), "room-123:" + firstLobby + ":1");
});

test("each Vampir Köylü lobby receives a distinct Durable Object identity", () => {
    const firstLobby = "0123456789abcdef0123456789abcdef";
    const secondLobby = "fedcba9876543210fedcba9876543210";
    const first = getVampirKoyluDurableObjectName("room-123", firstLobby, 1, "session-id-00000001");
    const second = getVampirKoyluDurableObjectName("room-123", secondLobby, 1, "session-id-00000001");
    assert.notEqual(first, second);
    assert.equal(first, "room-123:" + firstLobby + ":1:session-id-00000001");
});

test("Vampir session IDs are validated before routing", () => {
    assert.equal(isValidVampirKoyluSessionId("session-id-00000001"), true);
    assert.equal(isValidVampirKoyluSessionId("short"), false);
    assert.throws(() => getVampirKoyluDurableObjectName("room", "0123456789abcdef", 1, "short"));
    assert.throws(() => getVampirKoyluDurableObjectName("room", "0123456789abcdef", 0, "session-id-00000001"));
});

test("a round must still belong to the exact Vampir lobby session", () => {
    const identity = { sessionId: "session-id-00000001", round: 2 };
    assert.equal(matchesVampirKoyluSession({ sessionId: identity.sessionId, round: 2 }, identity), true);
    assert.equal(matchesVampirKoyluSession({ sessionId: "session-id-00000002", round: 2 }, identity), false);
    assert.equal(matchesVampirKoyluSession({ sessionId: identity.sessionId, round: 1 }, identity), false);
});
