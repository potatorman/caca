import test from "node:test";
import assert from "node:assert/strict";
import {
    findUploadedReleaseAsset,
    parsePrivateReleaseAssetUrl
} from "../src/game-downloads.js";

const OWNER = "potatorman";
const REPOSITORY = "arcade-game-vault";

test("parses a versioned private GitHub Release asset URL", () => {
    assert.deepEqual(
        parsePrivateReleaseAssetUrl(
            "https://github.com/potatorman/arcade-game-vault/releases/download/v1.2.0/A%20Game.zip",
            OWNER,
            REPOSITORY
        ),
        {
            owner: OWNER,
            repository: REPOSITORY,
            tag: "v1.2.0",
            filename: "A Game.zip"
        }
    );
});

test("rejects public/foreign hosts and a different repository", () => {
    for (const value of [
        "https://github.com/potatorman/arcade-game-zips/releases/download/v1/Game.zip",
        "https://github.io/potatorman/arcade-game-vault/releases/download/v1/Game.zip",
        "http://github.com/potatorman/arcade-game-vault/releases/download/v1/Game.zip",
        "https://example.com/potatorman/arcade-game-vault/releases/download/v1/Game.zip",
        "https://github.com/potatorman/arcade-game-vault/releases/download/v1/Game.zip?token=x",
        "https://github.com/potatorman/arcade-game-vault/releases/download/v1/folder%2FGame.zip"
    ]) {
        assert.equal(parsePrivateReleaseAssetUrl(value, OWNER, REPOSITORY), null, value);
    }
});

test("matches only an uploaded asset in a published release", () => {
    const asset = { id: 12345, name: "Game.zip", state: "uploaded", size: 1024 };
    const release = { draft: false, prerelease: false, assets: [asset] };
    assert.equal(findUploadedReleaseAsset(release, "Game.zip"), asset);
    assert.equal(findUploadedReleaseAsset(release, "Other.zip"), null);
    assert.equal(findUploadedReleaseAsset({ ...release, draft: true }, "Game.zip"), null);
    assert.equal(findUploadedReleaseAsset({ ...release, prerelease: true }, "Game.zip"), null);
    assert.equal(findUploadedReleaseAsset({ ...release, assets: [{ ...asset, state: "new" }] }, "Game.zip"), null);
    assert.equal(findUploadedReleaseAsset({ ...release, assets: [{ ...asset, id: "not-a-number" }] }, "Game.zip"), null);
});
