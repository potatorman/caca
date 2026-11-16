/* Stage 7 — touch-friendly workspace drawers and mobile navigation state. */
const appView = document.getElementById("appView");
const roomSidebar = document.getElementById("roomSidebar");
const mobileRoomsToggle = document.getElementById("mobileRoomsToggleButton");
const mobileDrawerBackdrop = document.getElementById("mobileDrawerBackdrop");
const roomChatLayout = document.getElementById("roomChatLayout");
const membersToggle = document.getElementById("membersToggleButton");
const roomView = document.getElementById("roomView");

if (appView && roomSidebar && mobileRoomsToggle && mobileDrawerBackdrop) {
    const mobileViewport = window.matchMedia("(max-width: 800px)");
    let roomDrawerOpen = false;
    let mobileMemberDefaultApplied = false;

    const isMembersPanelOpen = () => Boolean(
        roomChatLayout && !roomChatLayout.classList.contains("members-collapsed")
    );

    function applyMobileMemberDefault() {
        if (!mobileViewport.matches || mobileMemberDefaultApplied || !roomChatLayout || !membersToggle) {
            return;
        }
        roomChatLayout.classList.add("members-collapsed");
        membersToggle.setAttribute("aria-expanded", "false");
        membersToggle.innerHTML = 'Üyeleri göster <span aria-hidden="true">▥</span>';
        mobileMemberDefaultApplied = true;
    }

    function restoreDesktopMemberPanel() {
        if (!mobileMemberDefaultApplied || !roomChatLayout || !membersToggle) return;
        roomChatLayout.classList.remove("members-collapsed");
        membersToggle.setAttribute("aria-expanded", "true");
        membersToggle.innerHTML = 'Üyeler <span aria-hidden="true">▥</span>';
        mobileMemberDefaultApplied = false;
    }

    function syncDrawerState() {
        const mobile = mobileViewport.matches;
        const membersOpen = Boolean(
            mobile && isMembersPanelOpen() && roomView && !roomView.hidden
        );

        if (membersOpen) {
            roomDrawerOpen = false;
            appView.classList.remove("mobile-rooms-open");
        }

        appView.classList.toggle("mobile-rooms-open", mobile && roomDrawerOpen && !roomSidebar.hidden);
        appView.classList.toggle("mobile-members-open", membersOpen);
        mobileRoomsToggle.setAttribute(
            "aria-expanded",
            String(mobile && roomDrawerOpen && !roomSidebar.hidden)
        );
        mobileDrawerBackdrop.hidden = !(
            (mobile && roomDrawerOpen && !roomSidebar.hidden) || membersOpen
        );
    }

    function closeRoomDrawer(restoreFocus = false) {
        roomDrawerOpen = false;
        syncDrawerState();
        if (restoreFocus && mobileViewport.matches && !roomSidebar.hidden) {
            mobileRoomsToggle.focus();
        }
    }

    function openRoomDrawer() {
        if (!mobileViewport.matches || roomSidebar.hidden) return;
        if (isMembersPanelOpen() && membersToggle) membersToggle.click();
        roomDrawerOpen = true;
        syncDrawerState();
        const firstAction = roomSidebar.querySelector(
            "#globalChatNavButton, .room-list-item, summary, button"
        );
        firstAction?.focus();
    }

    function closeMembersDrawer() {
        if (isMembersPanelOpen() && membersToggle) membersToggle.click();
        syncDrawerState();
    }

    applyMobileMemberDefault();

    mobileRoomsToggle.addEventListener("click", () => {
        if (roomDrawerOpen) closeRoomDrawer(true);
        else openRoomDrawer();
    });

    mobileDrawerBackdrop.addEventListener("click", () => {
        if (isMembersPanelOpen()) closeMembersDrawer();
        closeRoomDrawer(true);
    });

    membersToggle?.addEventListener("click", () => {
        roomDrawerOpen = false;
        queueMicrotask(syncDrawerState);
    });

    roomSidebar.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("#globalChatNavButton, .room-list-item")) {
            closeRoomDrawer(false);
        }
    });

    roomSidebar.addEventListener("submit", (event) => {
        if (event.target instanceof HTMLFormElement &&
            event.target.matches("#createRoomForm, #joinRoomForm")) {
            closeRoomDrawer(false);
        }
    });

    document.getElementById("closeMembersButton")?.addEventListener("click", () => {
        queueMicrotask(syncDrawerState);
    });
    document.getElementById("closeGlobalMembersButton")?.addEventListener("click", () => {
        queueMicrotask(syncDrawerState);
    });

    for (const id of [
        "chatsNavButton", "gamesNavButton", "archiveNavButton",
        "siteOwnerNavButton", "settingsButton", "logoutButton"
    ]) {
        document.getElementById(id)?.addEventListener("click", () => {
            closeMembersDrawer();
            closeRoomDrawer(false);
        });
    }

    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (roomDrawerOpen || isMembersPanelOpen()) {
            closeMembersDrawer();
            closeRoomDrawer(true);
        }
    });

    const onViewportChange = () => {
        if (!mobileViewport.matches) {
            roomDrawerOpen = false;
            restoreDesktopMemberPanel();
            appView.classList.remove("mobile-members-open", "mobile-rooms-open");
            mobileDrawerBackdrop.hidden = true;
            mobileRoomsToggle.setAttribute("aria-expanded", "false");
        } else {
            applyMobileMemberDefault();
            syncDrawerState();
        }
    };

    if (typeof mobileViewport.addEventListener === "function") {
        mobileViewport.addEventListener("change", onViewportChange);
    } else {
        mobileViewport.addListener(onViewportChange);
    }

    syncDrawerState();
}
