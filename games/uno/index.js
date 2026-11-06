import { openUnoGame } from "./ui.js";
export { ensureMatch } from "./state.js";

export const unoGame = Object.freeze({
    id: "uno",
    name: "UNO",
    status: "ready",
    minPlayers: 2,
    maxPlayers: 10,
    open: openUnoGame
});

export default unoGame;
