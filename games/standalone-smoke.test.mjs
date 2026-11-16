import test from "node:test";
import assert from "node:assert/strict";

import { createBreakout } from "./breakout/engine.js";
import { SpaceInvaders } from "./space-invaders/engine.js";

function installBrowserMocks() {
    const listeners = new Map();
    const pendingFrames = new Map();
    let nextFrameId = 1;
    let frameTime = 0;

    const canvas = {
        width: 800,
        height: 950,
        getContext() { return context; },
        focus() {}
    };

    const context = new Proxy({
        measureText() { return { width: 80 }; },
        createLinearGradient() { return { addColorStop() {} }; },
        createRadialGradient() { return { addColorStop() {} }; },
        createPattern() { return {}; }
    }, {
        get(target, property) {
            if (property in target) return target[property];
            return () => {};
        },
        set(target, property, value) {
            target[property] = value;
            return true;
        }
    });

    const document = {
        getElementById(id) {
            return id === "game-canvas" ? canvas : null;
        },
        addEventListener(type, callback) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(callback);
        },
        removeEventListener(type, callback) {
            listeners.get(type)?.delete(callback);
        },
        dispatchEvent(event) {
            for (const callback of listeners.get(event.type) || []) callback(event);
            return true;
        }
    };

    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        Image: globalThis.Image,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame,
        performance: globalThis.performance
    };

    globalThis.document = document;
    globalThis.window = { screen: { availHeight: 900 } };
    globalThis.performance = { now: () => 0 };
    globalThis.Image = class {
        constructor() {
            this.width = 128;
            this.height = 128;
            this.complete = true;
        }
        set src(value) { this._src = value; }
        get src() { return this._src; }
    };
    globalThis.requestAnimationFrame = (callback) => {
        const id = nextFrameId++;
        pendingFrames.set(id, callback);
        return id;
    };
    globalThis.cancelAnimationFrame = (id) => pendingFrames.delete(id);

    return {
        listeners,
        pendingFrames,
        dispatchKeyboard(type, keyCode) {
            const event = { type, keyCode, which: keyCode, preventDefault() {} };
            document.dispatchEvent(event);
        },
        runFrames(count) {
            for (let index = 0; index < count; index += 1) {
                const next = pendingFrames.entries().next().value;
                if (!next) break;
                const [id, callback] = next;
                pendingFrames.delete(id);
                frameTime += 17;
                callback(frameTime);
            }
        },
        restore() {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        }
    };
}

test("Breakout starts a frame loop and releases it and its key listeners on close", () => {
    const mock = installBrowserMocks();
    const game = createBreakout();
    try {
        game.start();
        assert.equal(mock.pendingFrames.size, 1, "one animation frame should be scheduled");
        assert.equal(mock.listeners.get("keyup")?.size, 1, "welcome controls should be registered");

        mock.dispatchKeyboard("keyup", 49);
        assert.equal(mock.listeners.get("keydown")?.size, 1, "court controls should be registered after starting");
        mock.runFrames(8);
        assert.equal(mock.pendingFrames.size, 1, "gameplay should keep its animation loop alive");

        game.stop();
        assert.equal(mock.pendingFrames.size, 0, "animation frame should be cancelled");
        assert.equal(mock.listeners.get("keyup")?.size || 0, 0, "keyboard listener should be removed");

        game.stop();
        assert.equal(mock.pendingFrames.size, 0, "close should be idempotent");
    } finally {
        game.stop();
        mock.restore();
    }
});

test("Space Invaders starts a frame loop and releases it and its key listeners on close", () => {
    const mock = installBrowserMocks();
    const game = new SpaceInvaders.Game();
    try {
        game.start();
        assert.equal(mock.pendingFrames.size, 1, "one animation frame should be scheduled");
        assert.ok((mock.listeners.get("keyup")?.size || 0) > 0, "welcome controls should be registered");

        mock.dispatchKeyboard("keyup", 49);
        mock.runFrames(175);
        assert.equal(mock.pendingFrames.size, 1, "the active gameplay state should continue rendering");
        assert.ok((mock.listeners.get("keydown")?.size || 0) > 0, "gameplay keyboard controls should be registered");

        game.stop();
        assert.equal(mock.pendingFrames.size, 0, "animation frame should be cancelled");
        assert.equal(mock.listeners.get("keyup")?.size || 0, 0, "keyboard listener should be removed");

        game.stop();
        assert.equal(mock.pendingFrames.size, 0, "close should be idempotent");
    } finally {
        game.stop();
        mock.restore();
    }
});
