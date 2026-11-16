const $ = (id) => document.getElementById(id);

const mobileQuery = window.matchMedia("(max-width: 760px)");
const appView = $("appView");
const mobileHome = $("mobileHomeView");
const roomSidebar = $("mobileRoomSidebar");
const roomBackdrop = $("mobileRoomBackdrop");
const moreBackdrop = $("mobileMoreBackdrop");
const moreSheet = $("mobileMoreSheet");
const mobilePageTitle = $("mobilePageTitle");
const mobilePageEyebrow = $("mobilePageEyebrow");
const mobileRoomsButton = $("mobileRoomsButton");
const mobileMoreButton = $("mobileMoreButton");
const mobileBottomNav = $("mobileBottomNav");
const mobileRoomCards = $("mobileRoomCards");

let roomListObserver = null;
let viewObservers = [];
let avatarObserver = null;
let welcomeObserver = null;
let lastMobileRoomId = "";
let hadMobileRoomCollapse = false;
let previousFocus = null;

function isMobile() {
    return mobileQuery.matches;
}

function clickExisting(id) {
    const button = $(id);
    if (button && !button.disabled) button.click();
}

function closeRoomDrawer({ restoreFocus = false } = {}) {
    document.body.classList.remove("mobile-rooms-open");
    roomBackdrop.hidden = true;
    mobileRoomsButton?.setAttribute("aria-expanded", "false");
    if (restoreFocus && isMobile()) mobileRoomsButton?.focus();
}

function openRoomDrawer() {
    if (!isMobile()) return;
    closeMoreSheet();

    if (roomSidebar?.hidden) {
        clickExisting("chatsNavButton");
    }

    roomBackdrop.hidden = false;
    document.body.classList.add("mobile-rooms-open");
    mobileRoomsButton?.setAttribute("aria-expanded", "true");

    const activeRoom = roomSidebar?.querySelector(".room-list-item.active");
    const firstTarget = activeRoom || $("globalChatNavButton");
    window.requestAnimationFrame(() => firstTarget?.focus());
}

function closeMoreSheet({ restoreFocus = false } = {}) {
    document.body.classList.remove("mobile-more-open");
    moreBackdrop.hidden = true;
    moreSheet.hidden = true;
    mobileMoreButton?.setAttribute("aria-expanded", "false");
    mobileBottomNav?.querySelector('[data-mobile-action="more"]')?.setAttribute("aria-expanded", "false");
    if (restoreFocus && isMobile()) mobileMoreButton?.focus();
}

function openMoreSheet() {
    if (!isMobile()) return;
    closeRoomDrawer();
    previousFocus = document.activeElement;
    moreBackdrop.hidden = false;
    moreSheet.hidden = false;
    document.body.classList.add("mobile-more-open");
    mobileMoreButton?.setAttribute("aria-expanded", "true");
    mobileBottomNav?.querySelector('[data-mobile-action="more"]')?.setAttribute("aria-expanded", "true");
    window.requestAnimationFrame(() => $("mobileMoreSettings")?.focus());
}

function renderMobileRoomCards() {
    if (!mobileRoomCards) return;
    const source = $("roomsList");
    if (!source) return;

    const sourceButtons = [...source.querySelectorAll(".room-list-item")];
    mobileRoomCards.replaceChildren();

    if (!sourceButtons.length) {
        const emptySource = source.querySelector(".empty-rooms");
        const empty = document.createElement("div");
        empty.className = "mobile-room-empty";
        const icon = document.createElement("span");
        icon.className = "mobile-room-empty-icon";
        icon.textContent = "✦";
        const title = document.createElement("strong");
        title.textContent = emptySource?.textContent || "Henüz bir odan yok.";
        const hint = document.createElement("span");
        hint.textContent = "İlk odanı oluştur veya bir davet koduyla katıl.";
        const action = document.createElement("button");
        action.type = "button";
        action.textContent = "Oda oluştur";
        action.addEventListener("click", () => openRoomDrawerAndExpand("create"));
        empty.append(icon, title, hint, action);
        mobileRoomCards.appendChild(empty);
        return;
    }

    for (const sourceButton of sourceButtons) {
        const roomId = sourceButton.dataset.roomId;
        if (!roomId) continue;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "mobile-room-card";
        button.dataset.roomId = roomId;
        button.classList.toggle("is-active", sourceButton.classList.contains("active"));

        const icon = document.createElement("span");
        icon.className = "mobile-room-card-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "◎";

        const copy = document.createElement("span");
        copy.className = "mobile-room-card-copy";
        const name = document.createElement("strong");
        name.textContent = sourceButton.querySelector("strong")?.textContent || "Özel oda";
        const detail = document.createElement("small");
        detail.textContent = sourceButton.querySelector("span")?.textContent?.trim() || "Sohbet odası";
        copy.append(name, detail);

        const arrow = document.createElement("span");
        arrow.className = "mobile-room-card-arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "↗";

        button.append(icon, copy, arrow);
        button.addEventListener("click", () => {
            sourceButton.click();
            renderMobileRoomCards();
            closeRoomDrawer();
        });
        mobileRoomCards.appendChild(button);
    }
}

function openRoomDrawerAndExpand(which) {
    openRoomDrawer();
    const details = [...(roomSidebar?.querySelectorAll(".sidebar-action") || [])];
    const target = details[which === "join" ? 1 : 0];
    if (target) {
        details.forEach((entry) => {
            if (entry !== target) entry.open = false;
        });
        target.open = true;
        window.requestAnimationFrame(() => {
            target.querySelector("summary")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
    }
}

function copyDesktopAvatar() {
    const source = $("userAvatar");
    const target = $("mobileUserAvatar");
    if (!source || !target) return;
    target.className = "mobile-user-avatar";
    target.innerHTML = source.innerHTML;
    target.style.cssText = source.style.cssText;
    target.setAttribute("aria-hidden", "true");
}

function syncMobileOwnerAccess() {
    const isOwner = window.cacaIsSiteOwner === true;
    const ownerAction = $("mobileMoreOwner");
    if (ownerAction) ownerAction.hidden = !isOwner;
}

function syncMobileNav() {
    const tabs = mobileBottomNav?.querySelectorAll("[data-mobile-tab]");
    if (!tabs) return;

    const settingsOpen = !$("settingsView")?.hidden;
    const ownerOpen = !$("siteOwnerView")?.hidden;
    const gamesOpen = !$("gamesView")?.hidden;
    const archiveOpen = !$("archiveView")?.hidden;
    const activeTab = gamesOpen ? "games" : archiveOpen ? "archive" : (settingsOpen || ownerOpen) ? "more" : "chats";

    tabs.forEach((button) => {
        const active = button.dataset.mobileTab === activeTab;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
    });

    const more = mobileBottomNav.querySelector('[data-mobile-action="more"]');
    if (more) {
        const active = activeTab === "more";
        more.classList.toggle("is-active", active);
        more.setAttribute("aria-pressed", String(active));
    }
}

function syncMobileScreen() {
    const mobile = isMobile();
    document.body.classList.toggle("mobile-native", mobile);

    if (!mobile) {
        closeRoomDrawer();
        closeMoreSheet();
        if (mobileHome) mobileHome.hidden = true;
        return;
    }

    const dashboardOpen = !$("dashboardView")?.hidden;
    const roomOpen = !$("roomView")?.hidden;
    const gamesOpen = !$("gamesView")?.hidden;
    const archiveOpen = !$("archiveView")?.hidden;
    const settingsOpen = !$("settingsView")?.hidden;
    const ownerOpen = !$("siteOwnerView")?.hidden;

    const showMobileHome = dashboardOpen && !roomOpen && !gamesOpen && !archiveOpen && !settingsOpen && !ownerOpen;
    if (mobileHome) mobileHome.hidden = !showMobileHome;
    document.body.classList.toggle("mobile-settings-open", settingsOpen);
    document.body.classList.toggle("mobile-owner-open", ownerOpen);

    let title = "Sohbetlerin";
    let eyebrow = "RENDECHAT SPACE";
    if (settingsOpen) {
        title = "Hesap ayarları";
        eyebrow = "PROFİLİN VE GÜVENLİĞİN";
    } else if (ownerOpen) {
        title = "Kontrol Merkezi";
        eyebrow = "SITE OWNER";
    } else if (gamesOpen) {
        title = "Oyunlar";
        eyebrow = "BİRLİKTE OYNA";
    } else if (archiveOpen) {
        title = "Oyun Kütüphanesi";
        eyebrow = "KEŞFET VE İNDİR";
    } else if (roomOpen) {
        title = $("activeRoomName")?.textContent?.trim() || "Sohbet";
        eyebrow = $("roomView")?.classList.contains("is-global-chat") ? "RENDECHAT TOPLULUĞU" : "ÖZEL ODA";
    }

    if (mobilePageTitle) mobilePageTitle.textContent = title;
    if (mobilePageEyebrow) mobilePageEyebrow.textContent = eyebrow;

    const username = $("welcomeUsername")?.textContent?.trim() || "Merhaba";
    const welcome = $("mobileWelcomeName");
    if (welcome) welcome.textContent = username;

    const roomButton = $("mobileCreateRoomButton");
    if (roomButton) roomButton.disabled = false;

    syncMobileNav();
    syncMobileOwnerAccess();
    renderMobileRoomCards();

    if (roomOpen) {
        const roomId = $("roomView")?.classList.contains("is-global-chat") ? "global" : $("activeRoomCode")?.textContent?.trim() || $("activeRoomName")?.textContent || "active";
        if (!hadMobileRoomCollapse || lastMobileRoomId !== roomId) {
            const toggle = $("membersToggleButton");
            if (toggle?.getAttribute("aria-expanded") === "true") toggle.click();
            hadMobileRoomCollapse = true;
            lastMobileRoomId = roomId;
        }
        closeRoomDrawer();
    } else {
        hadMobileRoomCollapse = false;
        lastMobileRoomId = "";
    }
}

function bindMobileActions() {
    $("mobileRoomsButton")?.addEventListener("click", openRoomDrawer);
    $("mobileRoomBackdrop")?.addEventListener("click", () => closeRoomDrawer({ restoreFocus: true }));
    $("mobileMoreButton")?.addEventListener("click", openMoreSheet);
    $("mobileMoreClose")?.addEventListener("click", () => closeMoreSheet({ restoreFocus: true }));
    $("mobileMoreBackdrop")?.addEventListener("click", () => closeMoreSheet({ restoreFocus: true }));

    $("mobileSettingsButton")?.addEventListener("click", () => {
        closeMoreSheet();
        closeRoomDrawer();
        clickExisting("settingsButton");
    });
    $("mobileMoreSettings")?.addEventListener("click", () => {
        closeMoreSheet();
        clickExisting("settingsButton");
    });
    $("mobileMoreOwner")?.addEventListener("click", () => {
        closeMoreSheet();
        clickExisting("siteOwnerNavButton");
    });
    $("mobileMoreLogout")?.addEventListener("click", () => {
        closeMoreSheet();
        clickExisting("logoutButton");
    });

    $("mobileGlobalChatButton")?.addEventListener("click", () => {
        closeRoomDrawer();
        clickExisting("globalChatNavButton");
    });
    $("mobileCreateRoomButton")?.addEventListener("click", () => openRoomDrawerAndExpand("create"));
    $("mobileJoinRoomButton")?.addEventListener("click", () => openRoomDrawerAndExpand("join"));
    $("mobileAllRoomsButton")?.addEventListener("click", openRoomDrawer);

    mobileBottomNav?.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        if (button.dataset.mobileAction === "more") {
            openMoreSheet();
            return;
        }

        const tab = button.dataset.mobileTab;
        const target = tab === "games" ? "gamesNavButton"
            : tab === "archive" ? "archiveNavButton"
                : tab === "chats" ? "chatsNavButton" : null;
        if (!target) return;
        closeMoreSheet();
        closeRoomDrawer();
        clickExisting(target);
    });

    roomSidebar?.addEventListener("click", (event) => {
        if (event.target.closest(".room-list-item") || event.target.closest("#globalChatNavButton")) {
            closeRoomDrawer();
        }
    });

    $("backToDashboard")?.addEventListener("click", () => closeRoomDrawer(), true);
    $("backFromSettings")?.addEventListener("click", () => closeMoreSheet(), true);
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (document.body.classList.contains("mobile-more-open")) closeMoreSheet({ restoreFocus: true });
        else if (document.body.classList.contains("mobile-rooms-open")) closeRoomDrawer({ restoreFocus: true });
    });

    document.addEventListener("caca:site-owner-role-changed", (event) => {
        if (typeof event.detail?.isSiteOwner === "boolean") {
            window.cacaIsSiteOwner = event.detail.isSiteOwner;
            syncMobileOwnerAccess();
        }
    });
    document.addEventListener("caca:site-owner-activated", () => {
        window.cacaIsSiteOwner = true;
        syncMobileOwnerAccess();
    });
}

function observeMobileData() {
    const source = $("roomsList");
    if (source && window.MutationObserver) {
        roomListObserver = new MutationObserver(renderMobileRoomCards);
        roomListObserver.observe(source, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class"] });
    }

    const viewIds = ["dashboardView", "roomView", "gamesView", "archiveView", "settingsView", "siteOwnerView"];
    for (const id of viewIds) {
        const view = $(id);
        if (!view || !window.MutationObserver) continue;
        const observer = new MutationObserver(syncMobileScreen);
        observer.observe(view, { attributes: true, attributeFilter: ["hidden", "class"] });
        viewObservers.push(observer);
    }

    const activeRoomName = $("activeRoomName");
    if (activeRoomName && window.MutationObserver) {
        const observer = new MutationObserver(syncMobileScreen);
        observer.observe(activeRoomName, { childList: true, characterData: true, subtree: true });
        viewObservers.push(observer);
    }

    const avatar = $("userAvatar");
    if (avatar && window.MutationObserver) {
        avatarObserver = new MutationObserver(copyDesktopAvatar);
        avatarObserver.observe(avatar, { attributes: true, childList: true, subtree: true, characterData: true });
    }

    const username = $("welcomeUsername");
    if (username && window.MutationObserver) {
        welcomeObserver = new MutationObserver(syncMobileScreen);
        welcomeObserver.observe(username, { childList: true, characterData: true, subtree: true });
    }
}

function initializeMobileWorkspace() {
    if (!appView) return;
    copyDesktopAvatar();
    syncMobileOwnerAccess();
    bindMobileActions();
    observeMobileData();
    renderMobileRoomCards();
    syncMobileScreen();

    if (typeof mobileQuery.addEventListener === "function") {
        mobileQuery.addEventListener("change", syncMobileScreen);
    } else {
        mobileQuery.addListener(syncMobileScreen);
    }

    document.addEventListener("caca:avatar-changed", copyDesktopAvatar);
    document.addEventListener("caca:nickname-changed", syncMobileScreen);
    window.addEventListener("pageshow", syncMobileScreen);

    document.addEventListener("focusin", (event) => {
        if (!isMobile()) return;
        if (event.target.matches("input, textarea, select, [contenteditable='true']")) {
            document.body.classList.add("mobile-keyboard-open");
        }
    });
    document.addEventListener("focusout", () => {
        if (!isMobile()) return;
        window.setTimeout(() => {
            const active = document.activeElement;
            if (!active?.matches?.("input, textarea, select, [contenteditable='true']")) {
                document.body.classList.remove("mobile-keyboard-open");
            }
        }, 120);
    });
}

initializeMobileWorkspace();
