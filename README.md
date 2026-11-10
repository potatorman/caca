# CACA

CACA is a Turkish-first browser chat and room game project.

## Games

- **UNO** — real-time multiplayer card game.
- **Vampir Köylü** — 5–12 player social deduction game with Vampir, Doktor and Köylü roles.

Vampir Köylü supports optional host-controlled bot filling:
- Toggle bot filling on or off in **Lobi Ayarları**.
- Choose a target of 5–12 total players.
- If enabled, one real player can start a match and the Worker fills the remaining seats with bots.
- Bots are synthetic Durable Object participants, not Firebase users or room members.
- Role-aware bots perform night actions, coordinate with human Vampires, vote from public information and participate in Turkish discussion.
- No external AI API is used.

The shared room lobby, account system, profiles, invitations and chat are handled by Firebase. Live game sessions are hosted by Cloudflare Workers and SQLite-backed Durable Objects.

Deployment, preview and secret setup instructions are in
[`cloudflare/uno-worker/README.md`](cloudflare/uno-worker/README.md).
