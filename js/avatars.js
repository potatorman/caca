export const DEFAULT_AVATAR_ID = "fox";

export const AVATARS = Object.freeze({
    fox: { emoji: "🦊", label: "Tilki" },
    panda: { emoji: "🐼", label: "Panda" },
    cat: { emoji: "🐱", label: "Kedi" },
    frog: { emoji: "🐸", label: "Kurbağa" },
    penguin: { emoji: "🐧", label: "Penguen" },
    bear: { emoji: "🐻", label: "Ayı" },
    octopus: { emoji: "🐙", label: "Ahtapot" },
    owl: { emoji: "🦉", label: "Baykuş" },
    wolf: { emoji: "🐺", label: "Kurt" },
    tiger: { emoji: "🐯", label: "Kaplan" },
    raccoon: { emoji: "🦝", label: "Rakun" },
    dragon: { emoji: "🐉", label: "Ejderha" }
});

export function getAvatar(avatarId) {
    return AVATARS[avatarId] || AVATARS[DEFAULT_AVATAR_ID];
}

export function setAvatarElement(element, avatarId) {
    if (!element) return;

    const validId = AVATARS[avatarId] ? avatarId : DEFAULT_AVATAR_ID;
    const avatar = AVATARS[validId];

    element.dataset.avatarId = validId;
    element.textContent = avatar.emoji;
    element.setAttribute("aria-label", `${avatar.label} avatarı`);
}
