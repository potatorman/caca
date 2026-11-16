import { SpaceInvaders } from "./engine.js";
import { bindTouchControls } from "../standalone-controls.js";

export const spaceInvadersGame = Object.freeze({
    id: "space-invaders",
    name: "Space Invaders",
    mode: "standalone",

    open({ container }) {
        const game = new SpaceInvaders.Game();
        const root = document.createElement("section");
        root.className = "standalone-game-content space-invaders-game";
        root.innerHTML = `
            <div class="standalone-game-copy">
                <p>Gezegeni uzaylı istilasından koru. Oyuna başlarken bir veya iki oyuncu seçebilirsin.</p>
                <p><strong>Klavye:</strong> 1 / 2 oyuncu seç · ← → hareket · Space ateş · Enter yeniden başlat</p>
            </div>
            <div class="standalone-game-board" tabindex="0" aria-label="Space Invaders oyun alanı">
                <canvas id="game-canvas" width="672" height="768">
                    Tarayıcın HTML5 canvas desteklemiyor.
                </canvas>
            </div>
            <div class="standalone-game-touch-controls" aria-label="Dokunmatik kontroller">
                <button type="button" data-keycode="49">1 oyuncu</button>
                <button type="button" data-keycode="50">2 oyuncu</button>
                <button type="button" data-keycode="37" aria-label="Sola hareket">←</button>
                <button type="button" data-keycode="32">Ateş</button>
                <button type="button" data-keycode="39" aria-label="Sağa hareket">→</button>
                <button type="button" data-keycode="13">Enter</button>
            </div>
            <p class="standalone-game-note">İki oyunculu mod aynı cihazda sıra tabanlıdır; çevrimiçi oda maçı değildir.</p>
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

export default spaceInvadersGame;
