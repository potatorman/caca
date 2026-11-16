// Shared pointer controls for locally mounted standalone games.
// The upstream engines consume keyboard events; synthetic events are dispatched
// through document so mouse, keyboard and touch all use the same game rules.
export function bindTouchControls(container, focusTarget = container) {
    const activePointers = new Map();
    const bindings = [];

    function dispatch(type, keyCode) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
            keyCode: { value: Number(keyCode) },
            which: { value: Number(keyCode) }
        });
        document.dispatchEvent(event);
    }

    function release(pointerId) {
        const binding = activePointers.get(pointerId);
        if (!binding) return;
        activePointers.delete(pointerId);
        dispatch("keyup", binding.keyCode);
    }

    for (const button of container.querySelectorAll("[data-keycode]")) {
        const keyCode = Number(button.dataset.keycode);
        if (!Number.isInteger(keyCode) || keyCode < 0) continue;

        const onPointerDown = (event) => {
            event.preventDefault();
            if (activePointers.has(event.pointerId)) return;
            focusTarget?.focus?.({ preventScroll: true });
            activePointers.set(event.pointerId, { keyCode });
            dispatch("keydown", keyCode);
            try { button.setPointerCapture(event.pointerId); } catch { /* optional */ }
        };
        const onPointerUp = (event) => {
            event.preventDefault();
            release(event.pointerId);
        };
        const onLostCapture = (event) => release(event.pointerId);

        button.addEventListener("pointerdown", onPointerDown);
        button.addEventListener("pointerup", onPointerUp);
        button.addEventListener("pointercancel", onPointerUp);
        button.addEventListener("lostpointercapture", onLostCapture);
        bindings.push(() => {
            button.removeEventListener("pointerdown", onPointerDown);
            button.removeEventListener("pointerup", onPointerUp);
            button.removeEventListener("pointercancel", onPointerUp);
            button.removeEventListener("lostpointercapture", onLostCapture);
        });
    }

    return function disposeTouchControls() {
        for (const pointerId of [...activePointers.keys()]) release(pointerId);
        bindings.forEach((dispose) => dispose());
    };
}
