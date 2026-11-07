# CACA

CACA is a browser-based chat and room game project.

## UNO backend

UNO's live match state and gameplay are hosted on Cloudflare Workers + Durable Objects.
Firebase continues to handle authentication, profiles, room membership, invitations, chat
and the persistent room game lobby.

Deployment and secret setup instructions are in
[`cloudflare/uno-worker/README.md`](cloudflare/uno-worker/README.md).

The Cloudflare backend is isolated from the main website hosting. The website connects to it
through the URL configured in `games/uno/worker-config.js`.
