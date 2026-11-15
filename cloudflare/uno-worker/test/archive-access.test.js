import test from "node:test";
import assert from "node:assert/strict";
import {
    constantTimeStringEqual,
    isValidArchiveAccessTicket
} from "../src/archive-access.js";

test("compares exact UTF-8 password strings including Turkish characters", () => {
    assert.equal(constantTimeStringEqual("açık örnek 123", "açık örnek 123"), true);
    assert.equal(constantTimeStringEqual("açık örnek 123", "acik ornek 123"), false);
    assert.equal(constantTimeStringEqual("Şifre", "şifre"), false);
    assert.equal(constantTimeStringEqual("", ""), true);
    assert.equal(constantTimeStringEqual("one", "two"), false);
});

test("accepts an archive ticket only for its signed-in Firebase user", () => {
    const ticket = { kind: "caca-archive-access", uid: "firebase-user-123" };
    assert.equal(isValidArchiveAccessTicket(ticket, "firebase-user-123"), true);
    assert.equal(isValidArchiveAccessTicket(ticket, "another-user"), false);
    assert.equal(isValidArchiveAccessTicket({ ...ticket, kind: "other-ticket" }, "firebase-user-123"), false);
    assert.equal(isValidArchiveAccessTicket(null, "firebase-user-123"), false);
});
