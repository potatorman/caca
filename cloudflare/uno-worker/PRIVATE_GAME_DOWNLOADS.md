# Private CACA Game Downloads

CACA can serve game ZIPs stored in a **private GitHub repository** to signed-in CACA members. The existing public release repository and its links remain supported during migration.

## Architecture

1. A CACA member clicks **Güvenli indir** on a published downloadable game.
2. The browser sends the member's Firebase ID token to `POST /api/download-ticket` on the existing `caca-uno` Cloudflare Worker.
3. The Worker verifies the Firebase token with Firebase Authentication and confirms the member's Firestore `users/{uid}` profile exists.
4. The Worker confirms the game is published and its private Release URL points to the configured private repository.
5. Using its server-only GitHub token, the Worker locates the exact uploaded Release asset and returns a signed download URL valid for 60 seconds.
6. The browser navigates to `GET /api/download?ticket=...`. The Worker re-checks the member profile, publication state and exact private URL, then streams the GitHub asset to the browser as an attachment.

The GitHub token is stored only as a Cloudflare encrypted secret. It is never sent to the browser. The file is streamed through the Worker; the Worker does not buffer the complete ZIP in memory.

## Important migration safety

- Keep `potatorman/arcade-game-zips` **public** for now. Existing public Release URLs must continue working.
- Create a separate private repository named `potatorman/arcade-game-vault`.
- Upload copies of game archives to private Releases. Do not delete the old public assets during setup.
- Existing catalog records keep using their current `downloadUrl` when `privateDownloadUrl` is empty.
- A catalog record switches to the private route only when its `privateDownloadUrl` field is filled in and saved.
- Migrate and test one game first. Keep its previous public URL in `downloadUrl` until private downloads are confirmed.
- Only after every private URL has been tested should you decide whether to remove old public links or make the old repository private. Do not change the old repository's visibility as part of the initial setup.

## One-time GitHub setup

### 1. Create the private release repository

On GitHub, create:

- Owner: `potatorman`
- Repository: `arcade-game-vault`
- Visibility: **Private**
- Initialize it with a README if GitHub asks whether to initialize the repository.

This is a separate repository. Do not convert `arcade-game-zips` to private yet.

### 2. Create a read-only fine-grained token

In GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens:

- Resource owner: `potatorman`
- Repository access: **Only select repositories** → `arcade-game-vault`
- Repository permissions: **Contents: Read-only**
- No Issues, Pull requests, Actions, Administration or other permissions are required.
- Give the token an expiry you can maintain and rotate it before expiry.

The Worker uses the token only for the GitHub Release metadata and asset-download endpoints. GitHub documents that both endpoints accept fine-grained tokens with Contents read permission.

### 3. Add the token to Cloudflare

Open Cloudflare → Workers & Pages → `caca-uno` → Settings → Variables & Secrets.

Add an **encrypted Secret**:

- Name: `GITHUB_RELEASES_TOKEN`
- Value: the fine-grained token created above

Do not put the token in `wrangler.jsonc`, GitHub source files, Firestore or browser code.

The Worker configuration already declares these non-secret variables in production and Preview environments:

- `GAME_RELEASES_OWNER=potatorman`
- `GAME_RELEASES_REPO=arcade-game-vault`

The existing `FIREBASE_SERVICE_ACCOUNT_JSON` and `CACA_TICKET_SECRET` secrets are reused. No additional Firebase roles or paid storage service are required for this download path.

## Deploy the Worker before switching catalog entries

Cloudflare Workers Builds for this project should remain connected to:

- Repository: `potatorman/caca`
- Root directory: `cloudflare/uno-worker`
- Production branch: `main`
- Deploy command: `npm run deploy`

The private-download routes are part of the existing `caca-uno` Worker. They are not active in production until the Worker source containing them is deployed. Set `GITHUB_RELEASES_TOKEN` before enabling any private URL in the live catalog.

After the Worker has deployed, check:

```
https://caca-uno.patatesadam1589.workers.dev/health
```

The Worker should report its current health response. A successful health check alone does not prove that the private token is valid; complete a real signed-in test download.

## Publish a private game version

For every game archive:

1. Open `potatorman/arcade-game-vault`.
2. Create a published GitHub Release with a unique tag, for example `browserquest-v1.0.0`.
3. Attach the ZIP as a Release asset and publish.
4. Copy the direct asset URL, not the Release page URL. It should look like:

```
https://github.com/potatorman/arcade-game-vault/releases/download/browserquest-v1.0.0/BrowserQuest-v1.0.0.zip
```

Each individual GitHub Release asset must be smaller than 2 GiB.

## Enable a game in CACA

In Site Owner → Game Catalog → Edit game → Download information:

- **Private GitHub Release URL:** paste the direct private Release asset URL.
- **Existing public download URL:** keep the old public URL during the migration.
- **File size:** informational text only.

Save and publish the entry. The Games page will prefer the private route whenever `privateDownloadUrl` is present. If that field is empty, the existing public `downloadUrl` is used.

## Test checklist

Use a test downloadable game first:

- [ ] Its private Release exists and contains the exact ZIP asset.
- [ ] The Cloudflare Worker has `GITHUB_RELEASES_TOKEN` as an encrypted secret.
- [ ] A signed-in CACA member receives a short-lived download ticket and the ZIP downloads.
- [ ] A logged-out request cannot receive a ticket.
- [ ] A Firebase user without a CACA `users/{uid}` profile cannot receive a ticket.
- [ ] An unpublished game cannot be downloaded.
- [ ] Removing or changing `privateDownloadUrl` invalidates an already-issued ticket.
- [ ] A game with no private URL still uses its existing public download link.

## Free-plan notes

This uses GitHub private Releases plus the existing Cloudflare Worker and Firebase Authentication. No R2 bucket or paid storage plan is required. Cloudflare Workers Free has a 100,000 requests/day allowance and no enforced HTTP response-body size limit; each private download uses two Worker requests (ticket + streamed file), in addition to the Worker's existing traffic. Usage is shared with the existing Worker routes, so monitor account limits as traffic grows.

## Rollback

To revert one game to its old public download, clear its `privateDownloadUrl` field and keep its existing public `downloadUrl`. The public repository and assets remain untouched.
