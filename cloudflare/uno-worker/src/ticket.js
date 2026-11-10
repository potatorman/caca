const encoder = new TextEncoder();

function base64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64Url(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function ticketKey(secret, usage) {
    if (typeof secret !== "string" || secret.length < 32) {
        throw new Error("CACA_TICKET_SECRET en az 32 karakter olmalı.");
    }
    return crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        usage
    );
}

export async function signTicket(data, secret) {
    const payload = base64Url(encoder.encode(JSON.stringify(data)));
    const key = await ticketKey(secret, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    return payload + "." + base64Url(new Uint8Array(signature));
}

export async function verifyTicket(value, secret) {
    if (typeof value !== "string") throw new Error("Bağlantı bileti eksik.");
    const parts = value.split(".");
    if (parts.length !== 2) throw new Error("Bağlantı bileti geçersiz.");
    const key = await ticketKey(secret, ["verify"]);
    const valid = await crypto.subtle.verify(
        "HMAC",
        key,
        fromBase64Url(parts[1]),
        encoder.encode(parts[0])
    );
    if (!valid) throw new Error("Bağlantı bileti imzası geçersiz.");

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
    if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= Date.now()) {
        throw new Error("Bağlantı bileti süresi dolmuş.");
    }
    return payload;
}
