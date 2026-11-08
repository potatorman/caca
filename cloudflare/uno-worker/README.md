# CACA UNO Cloudflare Worker

This Worker hosts live UNO matches. The existing CACA website, Firebase Authentication,
room lobby, profiles, invitations and chat remain on Firebase.

## What moves to Cloudflare

- UNO deck, card hands and draw pile
- Turn order, card validation and all card effects
- UNO calls, penalties, quitting and roster repair
- Live state delivery over WebSockets
- Result acknowledgements and the transition back to the Firebase lobby

Firebase continues to own accounts and persistent room membership. Cloudflare stores the
active match in one SQLite-backed Durable Object per room and round. It writes the completed
result to `rooms/{roomId}/unoResults/{round}` and updates `gameSessions/active` when needed.
The legacy `unoMatches` documents are not used by the new client and are not automatically
deleted.

## Connect GitHub to Cloudflare

1. Create a free Cloudflare account and enable a `workers.dev` subdomain.
2. Open **Workers & Pages → Create application → Connect to Git**.
3. Connect `potatorman/caca`, select the `cloudflare/uno-worker` root directory, and select
   the `cloudflare-uno-migration` branch while testing.
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
  project `caca-dfe6`.

Create the service account in Google Cloud IAM for project `caca-dfe6` and grant it the
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

Open `https://YOUR-WORKER-URL/health`. The Worker should answer:

```json
{"ok":true,"service":"caca-uno","version":1}
```

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

For this repository, set the Workers Builds production branch to `cloudflare-uno-migration` and
its root directory to `/cloudflare/uno-worker`. Leave the build command empty and use
`npx wrangler deploy` as the deploy command. The old cancelled build from `main` is unrelated;
Workers Builds uses the currently saved settings on the next build.
