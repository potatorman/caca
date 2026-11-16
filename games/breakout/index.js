import { createBreakout } from "./engine.js";
import { bindTouchControls } from "../standalone-controls.js";

export const breakoutGame = Object.freeze({
    id: "breakout",
    name: "Breakout",
    mode: "standalone",

    open({ container }) {
        const game = createBreakout();
        const root = document.createElement("section");
        root.className = "standalone-game-content breakout-game";
        root.innerHTML = `
            <div class="standalone-game-copy">
                <p>Tuğlaları kır, topu düşürme. Başlamak için önce tek veya iki oyuncu seç.</p>
                <p><strong>Klavye:</strong> 1 / 2 oyuncu seç · ← → hareket · Space topu fırlat</p>
            </div>
            <div class="standalone-game-board" tabindex="0" aria-label="Breakout oyun alanı">
                <canvas id="game-canvas" width="800" height="950">
                    Tarayıcın HTML5 canvas desteklemiyor.
                </canvas>
            </div>
            <div class="standalone-game-touch-controls" aria-label="Dokunmatik kontroller">
                <button type="button" data-keycode="49">1 oyuncu</button>
                <button type="button" data-keycode="50">2 oyuncu</button>
                <button type="button" data-keycode="37" aria-label="Sola hareket">←</button>
                <button type="button" data-keycode="32">Topu fırlat</button>
                <button type="button" data-keycode="39" aria-label="Sağa hareket">→</button>
            </div>
            <p class="standalone-game-note">İki oyunculu mod aynı cihazda sırayla oynanır; çevrimiçi oda maçı değildir.</p>
        `;
        container.appendChild(root);
        const board = root.querySelector(".standalone-game-board");
        const disposeControls = bindTouchControls(root, board);
        try {
            game.start();
        } catch (error) {
            disposeControls();
            root.remove();
            throw error;
        }
        board.focus({ preventScroll: true });

        let closed = false;
        return {
            close() {
                if (closed) return;
                closed = true;
                disposeControls();
                game.stop();
                root.remove();
            }
        };
    }
});

export default breakoutGame;
