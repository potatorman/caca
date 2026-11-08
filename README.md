# CACA

CACA is a Turkish-first browser chat and room game project.

## Games

- **UNO** — real-time multiplayer card game.
- **Vampir Köylü** — 5–12 player social deduction game with Vampir, Doktor and Köylü roles.

The shared room lobby, account system, profiles, invitations and chat are handled by Firebase.
Live game sessions are hosted by Cloudflare Workers and SQLite-backed Durable Objects.

Deployment and secret setup instructions are in
[`cloudflare/uno-worker/README.md`](cloudflare/uno-worker/README.md).
