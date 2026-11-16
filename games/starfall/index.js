import { openStarfallGame } from "./ui.js";

export {
    forfeitMatch,
    returnToLobby,
    reconcileMatchPlayers
} from "./state.js";

export const starfallGame = Object.freeze({
    id: "starfall",
    name: "Starfall Grid",
    status: "ready",
    minPlayers: 2,
    maxPlayers: 8,
    open: openStarfallGame
});

export default starfallGame;
