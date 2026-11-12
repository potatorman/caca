import test from "node:test";
import assert from "node:assert/strict";

import {
    getVampirKoyluDurableObjectName,
    isValidVampirKoyluSessionId,
    matchesVampirKoyluSession
} from "../src/session-identity.js";

test("each Vampir Köylü lobby receives a distinct Durable Object identity", () => {
    const first = getVampirKoyluDurableObjectName("room-123", 1, "session-id-00000001");
    const second = getVampirKoyluDurableObjectName("room-123", 1, "session-id-00000002");

    assert.notEqual(first, second);
    assert.equal(first, "room-123:1:session-id-00000001");
});

test("Vampir session IDs are validated before routing", () => {
    assert.equal(isValidVampirKoyluSessionId("session-id-00000001"), true);
    assert.equal(isValidVampirKoyluSessionId("short"), false);
    assert.throws(() => getVampirKoyluDurableObjectName("room", 1, "short"));
    assert.throws(() => getVampirKoyluDurableObjectName("room", 0, "session-id-00000001"));
});

test("a round must still belong to the exact lobby session", () => {
    const identity = { sessionId: "session-id-00000001", round: 2 };
    assert.equal(matchesVampirKoyluSession({ sessionId: identity.sessionId, round: 2 }, identity), true);
    assert.equal(matchesVampirKoyluSession({ sessionId: "session-id-00000002", round: 2 }, identity), false);
    assert.equal(matchesVampirKoyluSession({ sessionId: identity.sessionId, round: 1 }, identity), false);
});
