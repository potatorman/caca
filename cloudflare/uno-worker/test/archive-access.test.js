import test from "node:test";
import assert from "node:assert/strict";
import { isValidArchiveAccessTicket } from "../src/archive-access.js";

test("accepts a library access ticket only for its signed-in Firebase user", () => {
    const ticket = { kind: "caca-archive-access", uid: "firebase-user-123" };
    assert.equal(isValidArchiveAccessTicket(ticket, "firebase-user-123"), true);
    assert.equal(isValidArchiveAccessTicket(ticket, "another-user"), false);
    assert.equal(isValidArchiveAccessTicket({ ...ticket, kind: "other-ticket" }, "firebase-user-123"), false);
    assert.equal(isValidArchiveAccessTicket({ ...ticket, uid: "" }, "firebase-user-123"), false);
    assert.equal(isValidArchiveAccessTicket(null, "firebase-user-123"), false);
    assert.equal(isValidArchiveAccessTicket(ticket, ""), false);
    assert.equal(isValidArchiveAccessTicket(ticket, null), false);
});
