// games/catalog-admin-init.js
// Initializes the game catalog admin UI when the Site Owner panel is available.
// Loaded as a separate module to keep the main site-owner.js unchanged.

import { mountCatalogAdmin, startCatalogAdminListener, stopCatalogAdminListener } from "./catalog-admin.js";

function tryMount() {
    const container = document.getElementById("ownerGameCatalogSection");
    if (!container || container.dataset.catalogMounted) return;
    container.dataset.catalogMounted = "1";
    mountCatalogAdmin(container);
}

document.addEventListener("caca:site-owner-activated", () => {
    tryMount();
    startCatalogAdminListener();
});

document.addEventListener("caca:site-owner-role-changed", (event) => {
    if (event.detail?.isSiteOwner) {
        tryMount();
        startCatalogAdminListener();
    } else {
        stopCatalogAdminListener();
    }
});

// If the page already has an active owner session on load
if (window.cacaIsSiteOwner) {
    tryMount();
    startCatalogAdminListener();
}
