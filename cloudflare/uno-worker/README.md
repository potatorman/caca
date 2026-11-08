# CACA Cloudflare Games Worker

This Worker hosts live UNO and Vampir Köylü matches. The existing CACA website, Firebase Authentication,
room lobby, profiles, invitations and chat remain on Firebase.

## What moves to Cloudflare

- UNO deck, card hands and draw pile
- UNO turn order, card validation, card effects and penalties
- Vampir Köylü hidden roles, night actions, doctor saves, discussion, voting and win checks
- Live state delivery over WebSockets
- Match exits, roster repair, result acknowledgements and return-to-lobby coordination

Firebase continues to own accounts and persistent room membership. Cloudflare stores the
active match in one SQLite-backed Durable Object per room and round. UNO results are recorded
in `rooms/{roomId}/unoResults/{round}`. Vampir Köylü keeps its hidden role map and private actions
inside its Durable Object. Both games update `gameSessions/active` when needed.
The legacy `unoMatches` documents are not used by the new client and are not automatically
deleted.

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

- `UNO_TICKET_SECRET`: a random secret with at least 32 characters.
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
and Wrangler's dry-run deployment check. The local `npm test` command is optional; Node.js is
not needed on the user's PC to run the deployed website or host a game.

## Important

Do not switch the live website to Cloudflare until the Worker is deployed, both secrets are set,
and `UNO_WORKER_URL` points to the exact deployed address. Until configured, the new UNO
client shows a setup error and does not fall back to Firestore gameplay.

## Workers Builds connection used for the migration

During migration testing, the Workers Builds production branch is
`cloudflare-uno-migration`. Keep the root directory at `/cloudflare/uno-worker`, leave the
build command empty and use `npx wrangler deploy` as the deploy command.

After this migration PR is merged, change the Workers Builds production branch to `main`.
That makes the Worker follow the same production branch as the live website.

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


## Cloudflare Preview Builds for pull requests

The production branch remains `main`. To test a feature branch before merging:

1. In **Workers & Pages → caca-uno → Settings → Builds → Branch control**, enable **Preview Builds**.
2. Keep the production branch set to `main` and the production deploy command set to `npx wrangler deploy`.
3. In **Settings → Variables & Secrets**, select **Previews Base** and add the encrypted secrets `UNO_TICKET_SECRET` and `FIREBASE_SERVICE_ACCOUNT_JSON` using the same values as Production. Never put either secret in the repository.
4. The Wrangler `previews` block already defines the preview Firebase project variables and both Durable Object bindings. Cloudflare creates isolated Durable Object namespaces for each Preview.
5. Use the Preview URL posted to the pull request for the Worker build. For Firebase preview testing, point the feature branch's `games/uno/worker-config.js` to that Preview Worker URL; restore the production URL before merging.

Preview Worker game sessions use the same Firebase project, so test only with test rooms and test accounts. Durable Object state is isolated per Preview.
