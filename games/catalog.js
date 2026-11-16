// games/catalog.js
// Universal game catalog. Merges the static GAME_REGISTRY with owner-managed
// entries stored in Firestore's `gamesCatalog` collection.
//
// Site owners add, edit and publish entries via the Site Owner panel.
// Browser games with lobbyEnabled:true automatically appear in the game picker.
// TYPE B (download) and TYPE C (download-mp) games render in the separate
// Oyun Kütüphanesi tab and do not create Firestore game sessions.

import { GAME_REGISTRY } from "./registry.js";

// Canonical schema for a catalog entry.
// Static GAME_REGISTRY entries are coerced into this shape on read.
export const DEFAULT_CATALOG_ENTRY = Object.freeze({
    id: "",
    name: "",
    description: "",
    icon: "🎮",
    coverUrl: "",
    screenshotUrls: [],
    // "browser" | "download" | "download-mp"
    type: "browser",
    // Whether this game appears in the lobby game picker (browser games only)
    lobbyEnabled: false,
    minPlayers: 2,
    maxPlayers: 10,
    // Relative module path for browser games, e.g. "./uno/index.js"
    module: null,
    version: "",
    downloadUrl: null,
    // Private GitHub Release URL; files are served through the authenticated CACA Worker.
    privateDownloadUrl: null,
    downloadSize: null,
    systemRequirements: null,
    published: true,
    // Source: "registry" | "firestore"
    _source: "registry"
});

// Coerce a raw GAME_REGISTRY entry into the catalog shape.
function registryEntryToCatalog(entry) {
    return {
        ...DEFAULT_CATALOG_ENTRY,
        id: entry.id,
        name: entry.name,
        description: entry.description || "",
        icon: entry.icon || "🎮",
        type: "browser",
        lobbyEnabled: entry.lobbyEnabled !== false,
        minPlayers: Number(entry.minPlayers) || 2,
        maxPlayers: Number(entry.maxPlayers) || 10,
        module: entry.module || null,
        published: entry.status === "ready" || entry.status == null,
        _source: "registry"
    };
}

// Coerce a raw Firestore document into the catalog shape.
export function firestoreDocToCatalog(id, data) {
    return {
        ...DEFAULT_CATALOG_ENTRY,
        id,
        name: String(data.name || ""),
        description: String(data.description || ""),
        icon: String(data.icon || "🎮"),
        coverUrl: String(data.coverUrl || ""),
        screenshotUrls: Array.isArray(data.screenshotUrls) ? data.screenshotUrls : [],
        type: ["browser", "download", "download-mp"].includes(data.type) ? data.type : "browser",
        lobbyEnabled: data.type === "browser" && data.lobbyEnabled === true,
        minPlayers: Number(data.minPlayers) || 2,
        maxPlayers: Number(data.maxPlayers) || 10,
        module: data.module ? String(data.module) : null,
        version: String(data.version || ""),
        downloadUrl: data.downloadUrl ? String(data.downloadUrl) : null,
        privateDownloadUrl: data.privateDownloadUrl ? String(data.privateDownloadUrl) : null,
        downloadSize: data.downloadSize ? String(data.downloadSize) : null,
        systemRequirements: data.systemRequirements ? String(data.systemRequirements) : null,
        published: data.published !== false,
        _source: "firestore"
    };
}

// In-memory cache so components don't re-fetch on every render.
let _catalogCache = null;
let _catalogListeners = [];
let _unsubscribeCatalog = null;

// Return the merged catalog: GAME_REGISTRY entries first (always present),
// then published Firestore entries that don't duplicate a registry id.
// Unpublished entries are hidden from non-owners. Pass isSiteOwner=true
// to include them (for the admin panel).
export function getMergedCatalog(firestoreEntries = [], isSiteOwner = false) {
    const registryEntries = GAME_REGISTRY.map(registryEntryToCatalog);
    const registryIds = new Set(registryEntries.map(e => e.id));

    const firestoreFiltered = firestoreEntries
        .filter(e => !registryIds.has(e.id))
        .filter(e => isSiteOwner || e.published);

    return [...registryEntries, ...firestoreFiltered];
}

// Subscribe to the gamesCatalog Firestore collection.
// Calls onChange(entries) with the current list whenever it changes.
// Returns an unsubscribe function.
export function subscribeToCatalog(db, onChange) {
    // Lazy import of Firestore to avoid circular deps at module parse time.
    import("https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js").then(
        ({ collection, onSnapshot, query, where }) => {
            if (_unsubscribeCatalog) _unsubscribeCatalog();

            // Public game pickers must never download unpublished drafts.
            // Site Owner drafts are read separately by catalog-admin.js.
            const q = query(
                collection(db, "gamesCatalog"),
                where("published", "==", true)
            );

            _unsubscribeCatalog = onSnapshot(q, snapshot => {
                // Keep a stable creation order without requiring a composite index.
                const orderedDocs = [...snapshot.docs].sort((a, b) => {
                    const aTime = a.data().createdAt?.toMillis?.() ?? 0;
                    const bTime = b.data().createdAt?.toMillis?.() ?? 0;
                    return aTime - bTime;
                });
                _catalogCache = orderedDocs.map(d => firestoreDocToCatalog(d.id, d.data()));
                _catalogListeners.forEach(fn => fn(_catalogCache));
                onChange(_catalogCache);
            }, error => {
                console.warn("CACA catalog listener failed:", error);
                // Fall back to empty — GAME_REGISTRY always covers the base games.
                onChange([]);
            });
        }
    );

    return () => {
        if (_unsubscribeCatalog) {
            _unsubscribeCatalog();
            _unsubscribeCatalog = null;
        }
        _catalogCache = null;
    };
}

// Get the cached list synchronously (may be null before first snapshot).
export function getCachedCatalog() {
    return _catalogCache;
}

// Validate a catalog entry before writing to Firestore.
// Returns null on success, or an error message string.
export function validateCatalogEntry(data) {
    if (!data.id || !/^[a-z0-9-]{2,32}$/.test(data.id)) {
        return "Oyun ID'si 2-32 karakter, küçük harf, rakam ve tire içermeli.";
    }
    if (GAME_REGISTRY.some(e => e.id === data.id)) {
        return "Bu ID sistem oyunlarından biriyle çakışıyor (uno, vampir-koylu).";
    }
    if (!data.name || String(data.name).length < 2 || String(data.name).length > 40) {
        return "Oyun adı 2-40 karakter olmalı.";
    }
    if (!["download", "download-mp"].includes(data.type)) {
        return "Yalnızca indirilebilir tek oyunculu veya çok oyunculu oyun eklenebilir.";
    }
    if (typeof data.privateDownloadUrl !== "string" || !data.privateDownloadUrl.trim()) {
        return "Güvenli indirme için private game-vault Release bağlantısı zorunludur.";
    }
    return null;
}
