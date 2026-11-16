# Space Invaders

A RendeChat standalone adapter for Jon Toivonen's HTML5 Space Invaders game.

- Upstream: https://github.com/toivjon/html5-space-invaders
- Author: Jon Toivonen
- License: MIT (upstream LICENSE reproduced in this folder)
- Gameplay source: `engine.js`, adapted from upstream to use a module-relative local sprite sheet and expose a stop method for RendeChat lifecycle cleanup.
- Art asset: `space_invaders_spritesheet.png`, copied from upstream unmodified.
- RendeChat integration: `index.js`, including accessible on-screen controls for touch devices.

The upstream game supports one-player and two-player turn-based play. Local two-player play shares one device and is not an online RendeChat room session.
