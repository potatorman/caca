import { openVampirKoyluGame } from "./ui.js";

export {
    reconcileMatchPlayers,
    forfeitMatch,
    returnToLobby
} from "./state.js";

export const vampirKoyluGame = Object.freeze({
    id: "vampir-koylu",
    name: "Vampir Köylü",
    status: "ready",
    minPlayers: 5,
    maxPlayers: 12,
    open: openVampirKoyluGame
});

export default vampirKoyluGame;
