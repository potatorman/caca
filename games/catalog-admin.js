// games/catalog-admin.js
// Game catalog management for Site Owners.
// Mounts into #ownerGameCatalogSection inside the Site Owner view.
// Reuses the existing isSiteOwner state from site-owner.js via DOM events.

import { db } from "../js/firebase.js";
import {
    collection,
    doc,
    setDoc,
    updateDoc,
    deleteDoc,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";
import { firestoreDocToCatalog, validateCatalogEntry, DEFAULT_CATALOG_ENTRY } from "./catalog.js";
import { GAME_REGISTRY } from "./registry.js";

const $ = id => document.getElementById(id);

// ── State ──────────────────────────────────────────────────────────────────

let _entries = [];
let _editingId = null;
let _unsubscribe = null;
let _isSiteOwner = false;

// ── Mount ──────────────────────────────────────────────────────────────────

export function mountCatalogAdmin(containerElement) {
    containerElement.innerHTML = buildAdminHTML();
    bindEvents(containerElement);
}

function buildAdminHTML() {
    return `
<div class="owner-game-catalog">
    <div class="owner-section-heading">
        <div>
            <span class="small-label">OYUN KATALOĞU</span>
            <h3>Oyun yönetimi</h3>
            <p>Yeni oyun ekle, mevcut oyunları düzenle veya yayından kaldır. Sistem oyunları (UNO, Vampir Köylü) buradan değiştirilemez.</p>
        </div>
        <button id="catalogAddButton" class="primary-button catalog-add-button" type="button">+ Yeni oyun ekle</button>
    </div>

    <div id="catalogSystemGames" class="catalog-system-games">
        <div class="catalog-system-label"><span class="small-label">SİSTEM OYUNLARI (SALT OKUNUR)</span></div>
        <div id="catalogSystemList" class="catalog-entries-list"></div>
    </div>

    <div class="catalog-custom-section">
        <div class="catalog-system-label"><span class="small-label">KATALOG OYUNLARI</span></div>
        <p id="catalogStatus" class="catalog-status" role="status" aria-live="polite"></p>
        <div id="catalogEntriesList" class="catalog-entries-list"></div>
    </div>

    <dialog id="catalogEditDialog" class="catalog-edit-dialog" aria-labelledby="catalogEditTitle">
        <div class="catalog-edit-card">
            <div class="catalog-edit-heading">
                <div>
                    <span class="small-label">OYUN DÜZENLE</span>
                    <h4 id="catalogEditTitle">Yeni oyun</h4>
                </div>
                <button id="catalogEditClose" class="icon-button" type="button" aria-label="Kapat">×</button>
            </div>

            <div class="catalog-edit-form">
                <div class="catalog-field-row">
                    <label class="catalog-field">
                        <span>Oyun ID <small>(değiştirilemez, küçük harf-rakam-tire)</small></span>
                        <input id="catalogFieldId" type="text" placeholder="ornek-oyun" maxlength="32" autocomplete="off" spellcheck="false">
                    </label>
                    <label class="catalog-field">
                        <span>İkon (emoji)</span>
                        <input id="catalogFieldIcon" type="text" placeholder="🎮" maxlength="8">
                    </label>
                </div>

                <label class="catalog-field">
                    <span>Oyun adı</span>
                    <input id="catalogFieldName" type="text" placeholder="Oyun Adı" maxlength="40">
                </label>

                <label class="catalog-field">
                    <span>Açıklama</span>
                    <textarea id="catalogFieldDescription" rows="3" maxlength="400" placeholder="Kısa oyun açıklaması..."></textarea>
                </label>

                <div class="catalog-field-row">
                    <label class="catalog-field">
                        <span>Tür</span>
                        <select id="catalogFieldType">
                            <option value="browser">Browser (tarayıcıda oynanır)</option>
                            <option value="download">İndirilebilir (tek oyuncu)</option>
                            <option value="download-mp">İndirilebilir (çok oyunculu)</option>
                        </select>
                    </label>
                    <label class="catalog-field">
                        <span>Versiyon</span>
                        <input id="catalogFieldVersion" type="text" placeholder="1.0.0" maxlength="20">
                    </label>
                </div>

                <div id="catalogBrowserFields">
                    <div class="catalog-field-row">
                        <label class="catalog-field">
                            <span>Min. oyuncu</span>
                            <input id="catalogFieldMinPlayers" type="number" min="1" max="20" value="2">
                        </label>
                        <label class="catalog-field">
                            <span>Maks. oyuncu</span>
                            <input id="catalogFieldMaxPlayers" type="number" min="1" max="20" value="10">
                        </label>
                    </div>
                    <label class="catalog-field catalog-toggle-field">
                        <input id="catalogFieldLobbyEnabled" type="checkbox">
                        <span><strong>Lobi desteği</strong> <small>Oyunlar sekmesinde lobi oluşturulabilir</small></span>
                    </label>
                    <label class="catalog-field">
                        <span>Modül yolu <small>(./oyun-adi/index.js)</small></span>
                        <input id="catalogFieldModule" type="text" placeholder="./oyun-adi/index.js" maxlength="100" spellcheck="false">
                    </label>
                </div>

                <div id="catalogDownloadFields" hidden>
                    <label class="catalog-field">
                        <span>İndirme URL'si</span>
                        <input id="catalogFieldDownloadUrl" type="url" placeholder="https://..." maxlength="500">
                    </label>
                    <div class="catalog-field-row">
                        <label class="catalog-field">
                            <span>İndirme boyutu</span>
                            <input id="catalogFieldDownloadSize" type="text" placeholder="250 MB" maxlength="30">
                        </label>
                    </div>
                    <label class="catalog-field">
                        <span>Sistem gereksinimleri</span>
                        <textarea id="catalogFieldSysReq" rows="2" maxlength="300" placeholder="Windows 10+, 4 GB RAM..."></textarea>
                    </label>
                </div>

                <label class="catalog-field">
                    <span>Kapak görseli URL'si <small>(isteğe bağlı)</small></span>
                    <input id="catalogFieldCoverUrl" type="url" placeholder="https://..." maxlength="500">
                </label>

                <label class="catalog-field catalog-toggle-field">
                    <input id="catalogFieldPublished" type="checkbox" checked>
                    <span><strong>Yayında</strong> <small>Yayında değilse yalnızca Site Owner görebilir</small></span>
                </label>

                <p id="catalogEditStatus" class="catalog-edit-status" role="status" aria-live="polite"></p>

                <div class="catalog-edit-actions">
                    <button id="catalogSaveButton" class="primary-button" type="button">Kaydet</button>
                    <button id="catalogEditCancelButton" class="secondary-button" type="button">Vazgeç</button>
                </div>
            </div>
        </div>
    </dialog>
</div>`;
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderSystemGames() {
    const list = $("catalogSystemList");
    if (!list) return;
    list.replaceChildren(
        ...GAME_REGISTRY.map(game => createEntryRow({
            id: game.id,
            name: game.name,
            icon: game.icon || "🎮",
            type: "browser",
            published: true,
            _source: "registry"
        }, true))
    );
}

function renderCatalogEntries() {
    const list = $("catalogEntriesList");
    const status = $("catalogStatus");
    if (!list) return;
    list.replaceChildren();
    if (!_entries.length) {
        const empty = document.createElement("p");
        empty.className = "owner-console-empty";
        empty.textContent = "Henüz katalog oyunu eklenmemiş. İlk oyunu eklemek için + düğmesini kullan.";
        list.appendChild(empty);
        return;
    }
    list.replaceChildren(..._entries.map(e => createEntryRow(e, false)));
    if (status) status.textContent = "";
}

function createEntryRow(entry, isSystem) {
    const row = document.createElement("article");
    row.className = "catalog-entry-row";
    row.dataset.gameId = entry.id;

    const icon = document.createElement("span");
    icon.className = "catalog-entry-icon";
    icon.textContent = entry.icon || "🎮";

    const info = document.createElement("div");
    info.className = "catalog-entry-info";

    const name = document.createElement("strong");
    name.textContent = entry.name;

    const meta = document.createElement("span");
    meta.className = "catalog-entry-meta";
    const typeLabel = { browser: "Browser", download: "İndirilebilir", "download-mp": "İndirilebilir çok oyunculu" };
    meta.textContent = (typeLabel[entry.type] || entry.type) +
        (entry._source === "registry" ? " · Sistem" : "") +
        (!entry.published ? " · Yayında değil" : "");

    info.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "catalog-entry-actions";

    if (!isSystem) {
        const pubBadge = document.createElement("span");
        pubBadge.className = "catalog-pub-badge" + (entry.published ? " is-live" : "");
        pubBadge.textContent = entry.published ? "Yayında" : "Taslak";
        actions.appendChild(pubBadge);

        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "catalog-action-button";
        toggleBtn.textContent = entry.published ? "Yayından kaldır" : "Yayınla";
        toggleBtn.addEventListener("click", () => togglePublished(entry));
        actions.appendChild(toggleBtn);

        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "catalog-action-button catalog-edit-btn";
        editBtn.textContent = "Düzenle";
        editBtn.addEventListener("click", () => openEditDialog(entry.id));
        actions.appendChild(editBtn);

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "catalog-action-button catalog-delete-btn";
        deleteBtn.textContent = "Sil";
        deleteBtn.addEventListener("click", () => deleteEntry(entry.id, entry.name));
        actions.appendChild(deleteBtn);
    } else {
        const badge = document.createElement("span");
        badge.className = "catalog-pub-badge is-live";
        badge.textContent = "Aktif";
        actions.appendChild(badge);
    }

    row.append(icon, info, actions);
    return row;
}

// ── Dialog ─────────────────────────────────────────────────────────────────

function openEditDialog(gameId = null) {
    _editingId = gameId;
    const dialog = $("catalogEditDialog");
    const title = $("catalogEditTitle");
    const status = $("catalogEditStatus");
    if (!dialog) return;

    if (gameId) {
        const entry = _entries.find(e => e.id === gameId);
        if (!entry) return;
        title.textContent = entry.name + " · Düzenle";
        $("catalogFieldId").value = entry.id;
        $("catalogFieldId").disabled = true;
        $("catalogFieldName").value = entry.name;
        $("catalogFieldIcon").value = entry.icon;
        $("catalogFieldDescription").value = entry.description;
        $("catalogFieldType").value = entry.type;
        $("catalogFieldVersion").value = entry.version;
        $("catalogFieldMinPlayers").value = entry.minPlayers;
        $("catalogFieldMaxPlayers").value = entry.maxPlayers;
        $("catalogFieldLobbyEnabled").checked = entry.lobbyEnabled;
        $("catalogFieldModule").value = entry.module || "";
        $("catalogFieldDownloadUrl").value = entry.downloadUrl || "";
        $("catalogFieldDownloadSize").value = entry.downloadSize || "";
        $("catalogFieldSysReq").value = entry.systemRequirements || "";
        $("catalogFieldCoverUrl").value = entry.coverUrl || "";
        $("catalogFieldPublished").checked = entry.published;
    } else {
        title.textContent = "Yeni oyun ekle";
        $("catalogFieldId").value = "";
        $("catalogFieldId").disabled = false;
        $("catalogFieldName").value = "";
        $("catalogFieldIcon").value = "🎮";
        $("catalogFieldDescription").value = "";
        $("catalogFieldType").value = "browser";
        $("catalogFieldVersion").value = "";
        $("catalogFieldMinPlayers").value = "2";
        $("catalogFieldMaxPlayers").value = "10";
        $("catalogFieldLobbyEnabled").checked = false;
        $("catalogFieldModule").value = "";
        $("catalogFieldDownloadUrl").value = "";
        $("catalogFieldDownloadSize").value = "";
        $("catalogFieldSysReq").value = "";
        $("catalogFieldCoverUrl").value = "";
        $("catalogFieldPublished").checked = true;
    }

    if (status) status.textContent = "";
    updateTypeFields();
    dialog.showModal();
}

function closeEditDialog() {
    $("catalogEditDialog")?.close();
    _editingId = null;
}

function updateTypeFields() {
    const type = $("catalogFieldType")?.value;
    const browserFields = $("catalogBrowserFields");
    const downloadFields = $("catalogDownloadFields");
    if (browserFields) browserFields.hidden = type !== "browser";
    if (downloadFields) downloadFields.hidden = type === "browser";
}

// ── Write operations ───────────────────────────────────────────────────────

async function saveEntry() {
    const status = $("catalogEditStatus");
    const saveBtn = $("catalogSaveButton");
    if (status) status.textContent = "";

    const type = $("catalogFieldType").value;
    const id = (_editingId || $("catalogFieldId").value.trim().toLowerCase());
    const data = {
        id,
        name: $("catalogFieldName").value.trim(),
        icon: $("catalogFieldIcon").value.trim() || "🎮",
        description: $("catalogFieldDescription").value.trim(),
        type,
        version: $("catalogFieldVersion").value.trim(),
        published: $("catalogFieldPublished").checked,
        coverUrl: $("catalogFieldCoverUrl").value.trim() || "",
        screenshotUrls: [],
        minPlayers: type === "browser" ? Number($("catalogFieldMinPlayers").value) : 1,
        maxPlayers: type === "browser" ? Number($("catalogFieldMaxPlayers").value) : 1,
        lobbyEnabled: type === "browser" && $("catalogFieldLobbyEnabled").checked,
        module: type === "browser" ? ($("catalogFieldModule").value.trim() || null) : null,
        downloadUrl: type !== "browser" ? ($("catalogFieldDownloadUrl").value.trim() || null) : null,
        downloadSize: type !== "browser" ? ($("catalogFieldDownloadSize").value.trim() || null) : null,
        systemRequirements: type !== "browser" ? ($("catalogFieldSysReq").value.trim() || null) : null
    };

    const validationError = validateCatalogEntry(data);
    if (validationError) {
        if (status) status.textContent = validationError;
        return;
    }

    if (saveBtn) saveBtn.disabled = true;
    if (status) status.textContent = "Kaydediliyor...";

    try {
        const ref = doc(db, "gamesCatalog", id);
        if (_editingId) {
            await updateDoc(ref, {
                ...data,
                updatedAt: serverTimestamp()
            });
        } else {
            // Check id collision with existing firestore entries
            if (_entries.some(e => e.id === id)) {
                if (status) status.textContent = "Bu ID ile zaten bir oyun var.";
                return;
            }
            await setDoc(ref, {
                ...data,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
        }
        closeEditDialog();
    } catch (error) {
        console.error("CACA catalog save failed:", error);
        if (status) status.textContent = "Kaydedilemedi: " + (error.message || "Bilinmeyen hata");
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

async function togglePublished(entry) {
    try {
        await updateDoc(doc(db, "gamesCatalog", entry.id), {
            published: !entry.published,
            updatedAt: serverTimestamp()
        });
    } catch (error) {
        const status = $("catalogStatus");
        if (status) status.textContent = "Yayın durumu güncellenemedi: " + (error.message || "Bilinmeyen hata");
    }
}

async function deleteEntry(id, name) {
    if (!window.confirm(`"${name}" oyununu katalogdan kalıcı olarak silmek istiyor musun?`)) return;
    try {
        await deleteDoc(doc(db, "gamesCatalog", id));
    } catch (error) {
        const status = $("catalogStatus");
        if (status) status.textContent = "Silinemedi: " + (error.message || "Bilinmeyen hata");
    }
}

// ── Firestore listener ─────────────────────────────────────────────────────

export function startCatalogAdminListener() {
    if (_unsubscribe) return;

    const q = query(collection(db, "gamesCatalog"), orderBy("createdAt", "asc"));
    _unsubscribe = onSnapshot(q, snapshot => {
        _entries = snapshot.docs.map(d => firestoreDocToCatalog(d.id, d.data()));
        renderCatalogEntries();
    }, error => {
        console.warn("CACA catalog admin listener failed:", error);
        const status = $("catalogStatus");
        if (status) status.textContent = error.code === "permission-denied"
            ? "Katalog okunamadı. Firestore Rules güncellenmeli."
            : "Katalog yüklenemedi: " + (error.message || "Bilinmeyen hata");
    });
}

export function stopCatalogAdminListener() {
    if (_unsubscribe) {
        _unsubscribe();
        _unsubscribe = null;
    }
}

// ── Event binding ──────────────────────────────────────────────────────────

function bindEvents(container) {
    renderSystemGames();

    container.addEventListener("click", event => {
        const target = event.target;
        if (target.id === "catalogAddButton") openEditDialog(null);
        if (target.id === "catalogEditClose" || target.id === "catalogEditCancelButton") closeEditDialog();
        if (target.id === "catalogSaveButton") saveEntry();
    });

    container.addEventListener("change", event => {
        if (event.target.id === "catalogFieldType") updateTypeFields();
    });

    const dialog = container.querySelector("#catalogEditDialog");
    dialog?.addEventListener("click", event => {
        if (event.target === dialog) closeEditDialog();
    });

    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !$("catalogEditDialog")?.open) return;
        // Let the dialog handle Escape natively
    });

    // Listen for site owner state changes
    document.addEventListener("caca:site-owner-role-changed", event => {
        _isSiteOwner = event.detail?.isSiteOwner === true;
        if (_isSiteOwner) startCatalogAdminListener();
        else stopCatalogAdminListener();
    });

    document.addEventListener("caca:site-owner-activated", () => {
        _isSiteOwner = true;
        startCatalogAdminListener();
    });
}
