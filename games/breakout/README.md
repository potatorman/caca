# Breakout

A RendeChat standalone adapter for J. Toivonen's HTML5 Breakout game.

- Upstream: https://github.com/toivjon/html5-breakout
- Author: J. Toivonen
- License: MIT (upstream LICENSE reproduced in this folder)
- Gameplay source: `engine.js`, adapted from upstream to export a fresh engine instance and expose a stop method for RendeChat lifecycle cleanup.
- RendeChat integration: `index.js`, including accessible on-screen controls for touch devices.

The upstream game supports one-player and two-player turn-based play. Local two-player play shares one device and is not an online RendeChat room session.
