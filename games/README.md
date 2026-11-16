# CACA Games

CACA's games live as local modules in this folder. Game code and its assets are shipped with RendeChat; the site does not embed game websites or send players away to play.

## Two supported launch contracts

- **Room games** register with `launchMode: "lobby"` in `registry.js` and expose the existing room-game `open({ db, roomId, round, uid, session, roomMembers, ... })` API. The shared Firebase lobby and Cloudflare Worker/Durable Object own the multiplayer state. UNO and Vampir Köylü remain on this path.
- **Standalone games** register with `launchMode: "standalone"`, `lobbyEnabled: false`, and a local `module` path such as `./breakout/index.js`. The module exports a default object (or `{id}Game`) with `open({ container, entry })`; it mounts its actual game UI into RendeChat and returns `{ close() }` so keyboard listeners and animation loops are stopped when the dialog closes.

The catalog merges the static registry with published `gamesCatalog` Firestore entries. Site Owners can add standalone browser modules by registering the local module path and recording source, developer credits and license. The module must be part of the deployed repository. Firestore catalog metadata does not load executable code from a URL. Room multiplayer is deliberately not inferred from a standalone game's local two-player mode; a new room game needs a server-side game adapter and Worker validation before it can be marked lobby-enabled.

## Current games

| Game | Launch | Players | Source / license |
|---|---|---:|---|
| UNO | Shared room lobby | 2–10 online | CACA implementation |
| Vampir Köylü | Shared room lobby | 5–12 online | CACA implementation |
| Breakout | RendeChat standalone dialog | 1–2 same-device, turn-based | [toivjon/html5-breakout](https://github.com/toivjon/html5-breakout) · MIT |
| Space Invaders | RendeChat standalone dialog | 1–2 same-device, turn-based | [toivjon/html5-space-invaders](https://github.com/toivjon/html5-space-invaders) · MIT |

Each vendored game folder contains its upstream license and attribution. The gameplay source is kept separate from the RendeChat launcher adapter so future source projects can be added without changing the catalog renderer.

## Tests

Run the standalone engine lifecycle smoke tests with:

```sh
node --test games/standalone-smoke.test.mjs
```
