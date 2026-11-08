const AUTH_LOOKUP_URL = "https://identitytoolkit.googleapis.com/v1/accounts:lookup";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FIRESTORE_ROOT = "https://firestore.googleapis.com/v1/projects";

const encoder = new TextEncoder();
let cachedGoogleToken = null;
let cachedGoogleTokenUntil = 0;

function base64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    return atob(padded);
}

function decodeJwtPayload(token) {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Firebase oturumu geçersiz.");
    return JSON.parse(decodeBase64Url(parts[1]));
}

function pemToArrayBuffer(pem) {
    const body = pem
        .replace(/-----BEGIN PRIVATE KEY-----/g, "")
        .replace(/-----END PRIVATE KEY-----/g, "")
        .replace(/\s/g, "");
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
}

function encodeFirestoreValue(value) {
    if (value && typeof value === "object" && value.__firestoreTimestamp === true) {
        return { timestampValue: value.value };
    }
    if (value === null) return { nullValue: "NULL_VALUE" };
    if (typeof value === "string") return { stringValue: value };
    if (typeof value === "boolean") return { booleanValue: value };
    if (typeof value === "number") {
        return Number.isInteger(value)
            ? { integerValue: String(value) }
            : { doubleValue: value };
    }
    if (Array.isArray(value)) {
        return { arrayValue: { values: value.map(encodeFirestoreValue) } };
    }
    if (typeof value === "object") {
        return {
            mapValue: {
                fields: Object.fromEntries(
                    Object.entries(value).map(([key, item]) => [key, encodeFirestoreValue(item)])
                )
            }
        };
    }
    throw new Error("Firestore'a yazılamayan veri türü.");
}

function decodeFirestoreValue(value) {
    if (!value || typeof value !== "object") return null;
    if (Object.hasOwn(value, "stringValue")) return value.stringValue;
    if (Object.hasOwn(value, "integerValue")) return Number(value.integerValue);
    if (Object.hasOwn(value, "doubleValue")) return value.doubleValue;
    if (Object.hasOwn(value, "booleanValue")) return value.booleanValue;
    if (Object.hasOwn(value, "timestampValue")) return value.timestampValue;
    if (Object.hasOwn(value, "nullValue")) return null;
    if (value.arrayValue) {
        return (value.arrayValue.values || []).map(decodeFirestoreValue);
    }
    if (value.mapValue) {
        return decodeFirestoreFields(value.mapValue.fields || {});
    }
    return null;
}

function decodeFirestoreFields(fields = {}) {
    return Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [key, decodeFirestoreValue(value)])
    );
}

function firestoreUrl(env, documentPath) {
    const path = documentPath.split("/").map(encodeURIComponent).join("/");
    return FIRESTORE_ROOT + "/" + encodeURIComponent(env.FIREBASE_PROJECT_ID) +
        "/databases/(default)/documents/" + path;
}

async function getGoogleAccessToken(env) {
    if (cachedGoogleToken && cachedGoogleTokenUntil > Date.now() + 60_000) {
        return cachedGoogleToken;
    }

    let account;
    try {
        account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON || "");
    } catch {
        throw new Error("Cloudflare FIREBASE_SERVICE_ACCOUNT_JSON secret'i geçerli JSON değil.");
    }
    if (!account.client_email || !account.private_key) {
        throw new Error("Service account JSON içinde client_email veya private_key eksik.");
    }

    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const claims = base64Url(encoder.encode(JSON.stringify({
        iss: account.client_email,
        scope: "https://www.googleapis.com/auth/datastore",
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600
    })));
    const unsigned = header + "." + claims;
    const key = await crypto.subtle.importKey(
        "pkcs8",
        pemToArrayBuffer(account.private_key.replace(/\\n/g, "\n")),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        encoder.encode(unsigned)
    );
    const assertion = unsigned + "." + base64Url(new Uint8Array(signature));
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion
        })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
        throw new Error("Google servis erişim anahtarı alınamadı.");
    }

    cachedGoogleToken = payload.access_token;
    cachedGoogleTokenUntil = Date.now() + Number(payload.expires_in || 3600) * 1000;
    return cachedGoogleToken;
}

async function firestoreRequest(env, documentPath, options = {}) {
    const accessToken = await getGoogleAccessToken(env);
    const response = await fetch(firestoreUrl(env, documentPath) + (options.query || ""), {
        method: options.method || "GET",
        headers: {
            Authorization: "Bearer " + accessToken,
            ...(options.body ? { "Content-Type": "application/json" } : {})
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });

    if (response.status === 404 && options.allowMissing) return null;
    if (!response.ok) {
        const details = await response.json().catch(() => ({}));
        throw new Error(
            "Firestore sunucu isteği başarısız (" + response.status + "): " +
            (details.error?.message || response.statusText)
        );
    }
    if (response.status === 204) return null;
    return response.json().catch(() => null);
}

export async function authenticateFirebaseToken(idToken, env) {
    if (typeof idToken !== "string" || !idToken) {
        throw new Error("Firebase kimlik belirteci eksik.");
    }
    const response = await fetch(
        AUTH_LOOKUP_URL + "?key=" + encodeURIComponent(env.FIREBASE_WEB_API_KEY),
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken })
        }
    );
    const payload = await response.json().catch(() => ({}));
    const user = payload.users?.[0];
    if (!response.ok || !user || user.disabled) {
        throw new Error("Firebase oturumu geçersiz veya süresi dolmuş.");
    }

    const claims = decodeJwtPayload(idToken);
    const projectId = env.FIREBASE_PROJECT_ID;
    if (
        claims.aud !== projectId ||
        claims.iss !== "https://securetoken.google.com/" + projectId ||
        claims.sub !== user.localId ||
        !Number.isFinite(claims.exp) ||
        claims.exp * 1000 <= Date.now()
    ) {
        throw new Error("Firebase kimlik belirteci bu CACA projesine ait değil.");
    }
    const validSince = Number(user.validSince || 0);
    if (validSince && Number(claims.auth_time || 0) < validSince) {
        throw new Error("Firebase oturumu iptal edilmiş. Yeniden giriş yap.");
    }
    return { uid: user.localId, email: user.email || null };
}

export async function getFirestoreDocument(env, documentPath) {
    const result = await firestoreRequest(env, documentPath, { allowMissing: true });
    return result ? {
        name: result.name,
        data: decodeFirestoreFields(result.fields || {})
    } : null;
}

export function firestoreTimestamp(date = new Date()) {
    return { __firestoreTimestamp: true, value: date.toISOString() };
}

export async function patchFirestoreDocument(env, documentPath, fields) {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const query = new URLSearchParams();
    for (const [key] of entries) query.append("updateMask.fieldPaths", key);
    const encoded = Object.fromEntries(
        entries.map(([key, value]) => [key, encodeFirestoreValue(value)])
    );
    await firestoreRequest(env, documentPath, {
        method: "PATCH",
        query: "?" + query.toString(),
        body: { fields: encoded }
    });
}

export async function deleteFirestoreDocument(env, documentPath) {
    await firestoreRequest(env, documentPath, { method: "DELETE", allowMissing: true });
}
