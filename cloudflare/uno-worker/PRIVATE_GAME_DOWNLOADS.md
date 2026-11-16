# Private CACA Game Downloads

CACA serves downloadable game files from a **private GitHub repository** to signed-in CACA members. There is no separate shared archive password. The browser never receives the GitHub token or a direct private GitHub asset URL.

## Architecture

1. A signed-in member selects a published game in the **Oyun Kütüphanesi** tab.
2. The browser sends its Firebase ID token to `POST /api/archive/access`.
3. The Worker verifies the Firebase token and confirms that `users/{uid}` is a valid CACA member profile. It returns a signed archive-access ticket tied to that Firebase UID and valid for eight hours.
4. The browser keeps only this short-lived ticket in the current tab's session storage.
5. The browser sends the signed ticket with `POST /api/download-ticket`. The Worker verifies the ticket and confirms the game is published and its private Release URL points to the configured private repository.
6. Using its server-only GitHub token, the Worker locates the exact uploaded Release asset and returns a signed download URL valid for 60 seconds.
7. The browser navigates to `GET /api/download?ticket=...`. The Worker re-checks the member profile, publication state and exact private URL, then streams the GitHub asset to the browser as an attachment.

The GitHub token is stored only as a Cloudflare encrypted secret. It is never sent to the browser. The file is streamed through the Worker; the Worker does not buffer the complete ZIP in memory.

## Important migration safety

- New downloadable catalog entries require `privateDownloadUrl`. Use only the private `potatorman/game-vault` Release URL for files you want served through the protected download flow.
- A private entry never falls back to its public `downloadUrl` when a Worker request fails. This prevents an error from silently bypassing the private download path.
- Existing records with only `downloadUrl` are legacy public links. Anyone with such a link may still access the file outside RendeChat; CACA does not make a public GitHub asset private.
- Migrate and test one game first. Keep old public files only until the private version is confirmed, then remove or retire the public copy.
- The library page is visible to signed-in CACA members. Private game files remain in the private repository and are streamed only through the authenticated Worker.

## One-time GitHub setup

### 1. Create the private release repository

On GitHub, create:

- Owner: `potatorman`
- Repository: `game-vault`
- Visibility: **Private**
- Initialize it with a README if GitHub asks whether to initialize the repository.

This is a separate repository. Do not convert `arcade-game-zips` to private as part of the initial setup.

### 2. Create a read-only fine-grained token

In GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens:

- Resource owner: `potatorman`
- Repository access: **Only select repositories** → `game-vault`
- Repository permissions: **Contents: Read-only**
- No Issues, Pull requests, Actions, Administration or other permissions are required.
- Give the token an expiry you can maintain and rotate it before expiry.

The Worker uses the token only for GitHub Release metadata and asset-download endpoints.

### 3. Add the token to Cloudflare

Open Cloudflare → Workers & Pages → `caca-uno` → Settings → Variables & Secrets.

Add an **encrypted Secret**:

- Name: `GITHUB_RELEASES_TOKEN`
- Value: the fine-grained token created above

Do not put the token in `wrangler.jsonc`, GitHub source files, Firestore or browser code.

The existing `FIREBASE_SERVICE_ACCOUNT_JSON` and `CACA_TICKET_SECRET` secrets are reused. No shared archive password or extra Firebase role is required for this download path. If you created a `GAME_ARCHIVE_PASSWORD` secret for the old lock screen, the new Worker no longer reads it; you may remove it from Cloudflare → Workers & Pages → `caca-uno` → Settings → Variables & Secrets after the updated Worker is deployed.

The Worker configuration already declares these non-secret variables in production and Preview environments:

- `GAME_RELEASES_OWNER=potatorman`
- `GAME_RELEASES_REPO=game-vault`

## Deploy the Worker before switching catalog entries

Cloudflare Workers Builds for this project should remain connected to:

- Repository: `potatorman/caca`
- Root directory: `cloudflare/uno-worker`
- Production branch: `main`
- Deploy command: `npm run deploy`

The library-access and private-download routes are active in production only after the Worker source containing them is deployed. Set `GITHUB_RELEASES_TOKEN` before enabling any private URL in the live catalog.

After the Worker has deployed, check:

```
https://caca-uno.patatesadam1589.workers.dev/health
```

A successful health check alone does not prove the private token is valid; complete a real signed-in test download.

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
- **Existing public download URL:** legacy field only. It is not private and should not be used for new protected uploads.
- **File size:** informational text only.

Save and publish the entry. New entries must use `privateDownloadUrl`. Old entries with only a public `downloadUrl` remain publicly accessible outside CACA until you migrate and remove the public copy.

## Test checklist

Use a test downloadable game first:

- [ ] Its private Release exists and contains the exact ZIP asset.
- [ ] The Cloudflare Worker has `GITHUB_RELEASES_TOKEN` as an encrypted secret.
- [ ] A signed-in CACA member receives an eight-hour access ticket without entering another password.
- [ ] An access ticket cannot be used by a different Firebase UID.
- [ ] A missing or expired access ticket is rejected.
- [ ] A logged-out request cannot receive an access ticket.
- [ ] A Firebase user without a CACA `users/{uid}` profile cannot receive a ticket.
- [ ] An unpublished game cannot be downloaded.
- [ ] Removing or changing `privateDownloadUrl` invalidates an already-issued download ticket.
- [ ] A private download error never redirects to a legacy public URL.
- [ ] A legacy game with only a public URL is identified as unprotected and cannot use the private download flow.

## Free-plan notes

This uses GitHub private Releases plus the existing Cloudflare Worker and Firebase Authentication. No R2 bucket or paid storage plan is required. Each private download uses two Worker requests (download ticket + streamed file); the first download in a browser tab also uses one library-access ticket request. The signed library-access ticket is reused in that tab for up to eight hours. Usage is shared with the Worker's existing routes, so monitor account limits as traffic grows.

## Rollback

Do not replace a private game URL with a public URL for a game that must stay protected. Public-only catalog entries remain outside the private download flow. Public assets already published outside CACA remain downloadable by anyone until you remove those public Release assets or make their repository private.
