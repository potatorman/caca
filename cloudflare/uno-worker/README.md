# CACA Cloudflare Games Worker

This Worker hosts live UNO and Vampir Köylü matches. The existing CACA website, Firebase Authentication,
room lobby, profiles, invitations and chat remain on Firebase.

## What moves to Cloudflare

- UNO deck, card hands and draw pile
- UNO turn order, card validation, card effects and penalties
- Vampir Köylü hidden roles, night actions, doctor saves, discussion, voting and win checks
- Live state delivery over WebSockets
- Match exits, roster repair, result acknowledgements and return-to-lobby coordination

Firebase continues to own accounts, persistent room membership and the room game-lobby index.
Every lobby has its own document at `rooms/{roomId}/gameSessions/{lobbyId}`. Both game engines
carry that `lobbyId` through signed tickets, WebSocket routing and a dedicated Durable Object
identity. UNO result documents use `{lobbyId}_{round}` keys so separate tables never overwrite
each other. Vampir Köylü also retains a per-lobby session nonce for stale-session protection.
The old `gameSessions/active` document remains readable as a migration-only lobby; newly created
lobbies always use unique IDs. The legacy `unoMatches` documents are not automatically deleted.

## Connect GitHub to Cloudflare

1. Create a free Cloudflare account and enable a `workers.dev` subdomain.
2. Open **Workers & Pages → Create application → Connect to Git**.
3. Connect `potatorman/caca`, select the `cloudflare/uno-worker` root directory, and select
   the `main` branch for production (use a feature branch only for an isolated preview deployment).
4. Keep the Worker name as `caca-uno`; it must match `wrangler.jsonc`.
5. Leave **Build command** empty. Set **Deploy command** to `npm run deploy`.
6. Let Workers Builds install the dependency from this folder's `package.json`.
7. Save and deploy. Enable the `workers.dev` route if it is not enabled automatically.

Workers Builds runs the deployment from GitHub in Cloudflare's build environment whenever
the selected branch receives a commit. You do not need to install Node.js or keep a server
running on your PC.

## Required encrypted secrets

In the Worker **Settings → Variables & Secrets**, add these as encrypted secrets:

- `CACA_TICKET_SECRET`: a random secret with at least 32 characters.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: the full JSON key for a service account in Firebase
  project `caca-dfe6c`.

Create the service account in Google Cloud IAM for project `caca-dfe6c` and grant it the
**Cloud Datastore User** role. Do not put the JSON key in GitHub, the Worker source or browser
code. The Worker uses this service account only for server-side Firestore reads and writes.
Those IAM-authorized requests bypass Firestore Security Rules, so the Worker independently
verifies Firebase ID tokens, room membership, match roster and every game action.

The Firebase web API key and project ID are public client configuration. They are already
configured as non-secret Worker variables in `wrangler.jsonc`.

## Connect the CACA website

After the first successful deployment, copy the Worker's exact `workers.dev` HTTPS address.
Set the `UNO_WORKER_URL` value in `games/uno/worker-config.js` to that address, for example:

```js
export const UNO_WORKER_URL = "https://caca-uno.example.workers.dev";
```

Commit and deploy that website change using the existing Firebase Hosting process.

## Health check

Open `https://YOUR-WORKER-URL/health`. The Worker should answer with `ok: true` and service
`caca-uno` (version 2 or later).

## Runtime behavior

- Each room and round has one Durable Object.
- Match state, private player hands and reconnect state are stored in Durable Object storage.
- WebSocket snapshots contain public match data; a player's hand is sent only to that player.
- A reconnect requests a short-lived, signed ticket using the current Firebase ID token.
- A Durable Object alarm skips a turn after the configured 90-second timeout.
- A per-room action queue serializes match state changes.
- Completed results are written to Firestore; result acknowledgements are coordinated by the
  Durable Object.
- Browser clients do not write live match state to Firestore.

## Tests

The repository includes an automated GitHub Actions check that runs the deck/rules-engine tests
and Wrangler's dry-run deployment check. Run `powershell -ExecutionPolicy Bypass -File .\scripts\test-multi-lobby.ps1` from the repository root to run the Worker tests, browser-module syntax checks and Wrangler dry run locally. Node.js 22+ is only needed for this optional local test run; it is not needed to use the deployed website.

## Important

Do not switch the live website to Cloudflare until the Worker is deployed, both secrets are set,
and `UNO_WORKER_URL` points to the exact deployed address. Until configured, the new UNO
client shows a setup error and does not fall back to Firestore gameplay.

## Workers Builds connection used for the migration

The Workers Builds production branch should be `main`. Keep the root directory at
`/cloudflare/uno-worker`, leave the build command empty and use `npx wrangler deploy` as the
deploy command. Every commit pushed to `main` then publishes the Worker from this directory.

## Production deployment

The workflow `.github/workflows/firebase-production.yml` runs only on pushes to `main`
(including merges) or when manually dispatched from `main`. It first runs the UNO deck/rules
tests and Wrangler dry-run validation, then deploys the website to the live Firebase Hosting
channel and publishes the repository's Firestore rules. It does not deploy from migration
branches or pull-request preview builds.

The production deploy uses the GitHub Actions secret
`FIREBASE_SERVICE_ACCOUNT_CACA_DFE6C`. The credential must have the Firebase Hosting and
Firebase Rules permissions listed below. Firebase CLI deployment replaces the deployed
Firestore rules with the contents of `firestore.rules`; keep any console-edited rules mirrored
in that file before merging.

## Firebase Hosting preview for the migration PR

The repository's website files live at the repository root (`index.html`, `css/`, `js/`,
and `games/`). The migration branch's `firebase.json` therefore uses `public: "."` and
excludes the Worker source, Firestore rules and Markdown documentation from Hosting uploads.

The workflow `.github/workflows/firebase-hosting-preview.yml` deploys pull requests targeting
`main` to temporary Firebase Hosting preview channels. It does not deploy to the live channel.
Preview links expire after seven days and the Firebase Hosting action comments the preview URL
on the pull request.

### Separate GitHub deployment credentials

The Cloudflare Worker service account `caca-uno-worker` should keep only its Firestore data
permissions. Do not reuse its JSON key for GitHub Hosting deployment.

Create a separate Google Cloud service account in project `caca-dfe6c`, for example
`caca-firebase-preview`, with these roles:

- Firebase Hosting Admin (`roles/firebasehosting.admin`)
- Firebase Authentication Admin (`roles/firebaseauth.admin`)
- Firebase Rules Admin (`roles/firebaserules.admin`) — required for the production Firestore
  rules deployment
- Service Usage API Keys Viewer (`roles/serviceusage.apiKeysViewer`)
- Service Usage Viewer (`roles/serviceusage.serviceUsageViewer`)

Create a JSON key for this separate account, then add the complete JSON as a GitHub repository
Actions secret named `FIREBASE_SERVICE_ACCOUNT_CACA_DFE6C` in
**Settings → Secrets and variables → Actions**. Never commit the key to the repository.

The Firebase Hosting preview action requires this GitHub secret. Without it, its workflow
fails with `Input required and not supplied: firebaseServiceAccount`.

Firebase Hosting preview URLs are public, temporary URLs and use this project's real Firebase
backend resources. Use test rooms and test matches while validating the migration.



## Vampir Köylü

Vampir Köylü is available to 5–12 players. It uses only three roles:

- **Vampir:** one vampire with 5–7 players; two vampires with 8–12 players.
- **Doktor:** one doctor who secretly protects one living player per night (including themself).
- **Köylü:** all remaining players; they discuss and vote during the day.

The game runs night (25 seconds), day discussion (45 seconds) and voting (20 seconds). All active
players must submit night actions/votes for the phase to resolve early; otherwise the Durable
Object alarm resolves the phase when its timer expires. If multiple vampires choose different
targets, the unique highest target is attacked; a tie means nobody is attacked. A doctor save
prevents that night's elimination.

Discussion chat is part of the game overlay. Only living players can send messages, only during
the day. The Worker enforces the phase, membership, message length and rate limit. Private role
data is delivered only to the individual player; roles are revealed when players are eliminated
or when the match ends.

The separate Durable Object class is added by Wrangler migration `v2`; do not remove the
existing `UnoRoom` class or its `v1` migration.


## Cloudflare Worker Previews for pull requests

The production Worker remains on its currently configured production branch. **Do not change the production branch or production deploy command just to test this feature.**

The current repository uses Wrangler `4.135.0+` and has a `previews` section in `wrangler.jsonc` for preview Firebase variables and Durable Object bindings.

### Enable previews on the existing Worker

1. Open **Workers & Pages → caca-uno → Settings → Build → Branch control**.
2. Enable **Preview Builds** (or **Builds for non-production branches**, depending on the dashboard label).
3. If this existing Worker shows a **Set up Worker Previews** banner under **Settings → Builds**, select **Set up**, review the switch, and then select **Switch to Worker Previews**. This is a one-time change to the preview workflow; it does not change the production branch.
4. Confirm the Preview command is `npx wrangler preview`. Production should continue using its existing production deploy command.
5. Under **Settings → Variables & Secrets → Previews Base**, add the encrypted secrets `CACA_TICKET_SECRET` and `FIREBASE_SERVICE_ACCOUNT_JSON` with the same values used by the Worker. Never put either secret in the repository.

Newer Workers use `npx wrangler preview` for non-production branches. Existing Workers connected to Builds may need the one-time Worker Previews setup before this model is active. Cloudflare creates isolated Durable Object namespaces for each Preview when the Wrangler `previews` binding is configured.

### Build and obtain the feature Worker URL

Pushes to `feature/vampir-koylu` should trigger a preview build after Preview Builds are enabled. When it succeeds, open the Worker’s **Deployments → Previews** section and copy the exact Preview URL for `feature/vampir-koylu`.

Do not guess the Preview URL. The feature branch's `games/uno/worker-config.js` still points to the production Worker until that exact URL is entered. Update that file on `feature/vampir-koylu` only, then the Firebase Hosting preview can use the feature Worker without changing production.

### Firebase Rules are a separate deployment

The Firebase Hosting preview workflow deploys only the website to a temporary Hosting channel; it does **not** deploy `firestore.rules`. The preview website currently uses the existing `caca-dfe6c` Firebase backend.

The bot lobby settings require the updated rules in `firestore.rules`. Before testing settings, either:
- point the preview at a separate test Firebase project and deploy the branch's rules there; or
- intentionally deploy only the updated Firestore Rules to the shared `caca-dfe6c` project after reviewing them.

Do not merge this feature or deploy the new rules to the shared project merely to get a preview working. Production remains unchanged until the migration is deliberately approved.

Preview Worker sessions use the Firebase project configured in the `previews` block, so use test rooms and test accounts. Durable Object storage is isolated between Previews.
  
## Vampir Köylü bot lobileri

The Vampir Köylü lobby stores only real Firebase user IDs. Its optional `gameSettings` map contains the host-controlled `botFillEnabled` toggle and `targetPlayerCount` (5–12).

When bot filling is enabled, the Worker creates the missing seats inside `VampirKoyluRoom` after the real-player match roster is frozen. Synthetic bot IDs and roles exist only in Durable Object storage; they are not Firebase accounts, room members, lobby-ready entries or result-return acknowledgements.

Bot actions are performed by the Durable Object during night and voting phases. Bots use role-specific deterministic decision helpers from `games/vampir-koylu/bots.js`; no external AI service or API key is used. Real Vampire teammates get the first opportunity to submit a hidden choice so a Vampire bot can coordinate without exposing its action.


## Global lobby passwords

Global lobby passwords are handled only by the Worker endpoint `POST /api/lobby/manage`.

- `action: "set-password"` is restricted to the lobby host and stores a PBKDF2-HMAC-SHA256 verifier plus random salt under `rooms/global/lobbySecrets/{lobbyId}`.
- `action: "join"` checks the password server-side and updates the lobby roster through the Worker service account.
- Firestore Rules deny client reads/writes to `lobbySecrets` and deny direct client self-joins to global lobbies, so the public lobby document never contains the password or verifier.
- Leave the password blank to keep a lobby public. Passwords must be 4–64 characters.
