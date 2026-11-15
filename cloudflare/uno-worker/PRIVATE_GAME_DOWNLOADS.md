# Private CACA Game Downloads

CACA can serve game ZIPs stored in a **private GitHub repository** only to signed-in CACA members who also know the shared archive password. The password is checked by the Cloudflare Worker and is never stored in the website source. Public release links remain public and cannot be protected by this password.

## Architecture

1. A CACA member clicks **Arşiv parolasıyla indir** on a published downloadable game.
2. The browser asks for the password in a masked input dialog and sends it with the member's Firebase ID token to `POST /api/archive/unlock`.
3. The Worker verifies the Firebase token, confirms the member profile and checks the password against the encrypted `GAME_ARCHIVE_PASSWORD` Worker secret.
4. The Worker returns a signed archive-access ticket tied to that Firebase UID and valid for eight hours. The browser keeps only this short-lived ticket in the current tab's session storage; it never stores the password.
5. The browser sends the signed archive-access ticket with `POST /api/download-ticket`. The Worker verifies the ticket and confirms the game is published and its private Release URL points to the configured private repository.
6. Using its server-only GitHub token, the Worker locates the exact uploaded Release asset and returns a signed download URL valid for 60 seconds.
7. The browser navigates to `GET /api/download?ticket=...`. The Worker re-checks the member profile, publication state and exact private URL, then streams the GitHub asset to the browser as an attachment.

The GitHub token is stored only as a Cloudflare encrypted secret. It is never sent to the browser. The file is streamed through the Worker; the Worker does not buffer the complete ZIP in memory.

## Important migration safety

- Existing records with only `downloadUrl` remain public legacy downloads; anyone with the link can open them without the archive password.
- New downloadable catalog entries now require `privateDownloadUrl`. Use only the private `potatorman/game-vault` Release URL for games you want protected.
- A private entry never falls back to its public `downloadUrl` when the password check or Worker request fails. This prevents a public fallback from bypassing the password gate.
- Migrate and test one game first. Keep old public files only until the private version is confirmed, then remove or retire the public copy.
- Do not change the old repository's visibility as part of the initial setup. A public ZIP remains public even if CACA's page asks for a password.

## One-time GitHub setup

### 1. Create the private release repository

On GitHub, create:

- Owner: `potatorman`
- Repository: `game-vault`
- Visibility: **Private**
- Initialize it with a README if GitHub asks whether to initialize the repository.

This is a separate repository. Do not convert `arcade-game-zips` to private yet.

### 2. Create a read-only fine-grained token

In GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens:

- Resource owner: `potatorman`
- Repository access: **Only select repositories** → `game-vault`
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

Add a second encrypted Cloudflare Worker Secret:
- Name: `GAME_ARCHIVE_PASSWORD`
- Value: the shared password you give only to people you trust (at least 12 characters).

Never put this password in `wrangler.jsonc`, GitHub source files, Firestore or browser code.
Add it in the production Worker's **Settings → Variables & Secrets**. If you use Worker
Previews to test archive downloads, add it as an encrypted Preview secret too. The website
receives only a signed access ticket tied to the member's Firebase UID; the ticket expires
after eight hours.

The Worker configuration already declares these non-secret variables in production and Preview environments:

- `GAME_RELEASES_OWNER=potatorman`
- `GAME_RELEASES_REPO=game-vault`

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

1. Open `potatorman/game-vault`.
2. Create a published GitHub Release with a unique tag, for example `browserquest-v1.0.0`.
3. Attach the ZIP as a Release asset and publish.
4. Copy the direct asset URL, not the Release page URL. It should look like:

```
https://github.com/potatorman/game-vault/releases/download/browserquest-v1.0.0/BrowserQuest-v1.0.0.zip
```

Each individual GitHub Release asset must be smaller than 2 GiB.

## Enable a game in CACA

In Site Owner → Game Catalog → Edit game → Download information:

- **Private GitHub Release URL:** required; paste the direct private Release asset URL.
- **Existing public download URL:** legacy field only. It is not password-protected and should not be used for new private uploads.
- **File size:** informational text only.

Save and publish the entry. New entries must use `privateDownloadUrl`; the shared archive password is checked before the Worker issues a download ticket. Old entries with only a public `downloadUrl` remain publicly accessible until you migrate and remove the public copy.

## Test checklist

Use a test downloadable game first:

- [ ] Its private Release exists and contains the exact ZIP asset.
- [ ] The Cloudflare Worker has `GITHUB_RELEASES_TOKEN` as an encrypted secret.
- [ ] A signed-in CACA member with the correct archive password receives an eight-hour access ticket and can download the ZIP.
- [ ] A wrong password is rejected by the Worker.
- [ ] An archive-access ticket cannot be used by a different Firebase UID.
- [ ] A download-ticket request without a valid archive-access ticket is rejected.
- [ ] A private download error never redirects to a legacy public URL.
- [ ] A logged-out request cannot receive an access ticket.
- [ ] A Firebase user without a CACA `users/{uid}` profile cannot receive a ticket.
- [ ] An unpublished game cannot be downloaded.
- [ ] Removing or changing `privateDownloadUrl` invalidates an already-issued ticket.
- [ ] A legacy game with only a public URL is marked as unprotected and cannot be downloaded from the CACA library until moved to the private repository.

## Free-plan notes

This uses GitHub private Releases plus the existing Cloudflare Worker and Firebase Authentication. No R2 bucket or paid storage plan is required. Cloudflare Workers Free has a 100,000 requests/day allowance and no enforced HTTP response-body size limit; each private download uses two Worker requests (ticket + streamed file), in addition to the Worker's existing traffic. The first private download in a browser tab also uses one archive-unlock request; its signed access ticket is reused in that tab for up to eight hours. Usage is shared with the existing Worker routes, so monitor account limits as traffic grows.

## Rollback

Do not clear `privateDownloadUrl` and restore a public URL for a game that must stay protected. Legacy public-only entries are disabled in the CACA library. Public assets already published outside CACA remain downloadable by anyone until you remove those public Release assets or make their repository private.
