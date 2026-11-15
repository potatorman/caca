const SAFE_TAG = /^[A-Za-z0-9._-]{1,100}$/;
const SAFE_FILENAME = /^[^/\\\\\u0000-\u001f\u007f]{1,240}$/;

export function parsePrivateReleaseAssetUrl(value, expectedOwner, expectedRepository) {
    if (typeof value !== "string" || !value.trim()) return null;

    let url;
    try {
        url = new URL(value);
    } catch {
        return null;
    }

    if (
        url.protocol !== "https:" ||
        url.hostname !== "github.com" ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    ) {
        return null;
    }

    let segments;
    try {
        segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
        return null;
    }

    if (
        segments.length !== 6 ||
        segments[0].toLowerCase() !== String(expectedOwner || "").toLowerCase() ||
        segments[1].toLowerCase() !== String(expectedRepository || "").toLowerCase() ||
        segments[2] !== "releases" ||
        segments[3] !== "download"
    ) {
        return null;
    }

    const [, , , , tag, filename] = segments;
    if (
        !SAFE_TAG.test(tag) ||
        !SAFE_FILENAME.test(filename) ||
        filename === "." ||
        filename === ".."
    ) {
        return null;
    }

    return {
        owner: segments[0],
        repository: segments[1],
        tag,
        filename
    };
}

export function findUploadedReleaseAsset(release, expectedFilename) {
    if (
        !release ||
        release.draft === true ||
        release.prerelease === true ||
        !Array.isArray(release.assets)
    ) {
        return null;
    }

    return release.assets.find(asset =>
        asset &&
        asset.name === expectedFilename &&
        asset.state === "uploaded" &&
        Number.isSafeInteger(Number(asset.id)) &&
        Number(asset.id) > 0
    ) || null;
}
