/**
 * GitHub credential lifecycle (LOCAL ONLY): parse what is stored in the
 * Keychain, refresh the short-lived access token with the refresh token, and
 * decide when a credential is truly dead.
 *
 * GitHub App user tokens from the device flow expire after ~8 hours and come
 * with a ~6-month refresh token. GitHub documents that refreshing a token
 * that came from the device flow needs only the client ID (no client secret).
 * Refresh tokens rotate: every refresh returns a new one and the old one
 * stops working, so the new credential is saved before it is used.
 *
 * No value in this module is ever logged, printed or sent anywhere except
 * github.com.
 */

export const CLIENT_ID = "Iv23liPKSmWq5mgNQHdx";
export const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 10 * 60 * 1000;

/** Build the stored credential from a GitHub token response. */
export function credentialFromResponse(body, now = Date.now()) {
  if (!body || typeof body.access_token !== "string" || !body.access_token) return null;
  const secs = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) * 1000 : null);
  const accessMs = secs(body.expires_in);
  const refreshMs = secs(body.refresh_token_expires_in);
  return {
    v: 2,
    accessToken: body.access_token,
    accessExpiresAt: accessMs ? now + accessMs : null,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
    refreshExpiresAt: refreshMs ? now + refreshMs : null,
  };
}

/** Parse the Keychain value. Legacy entries are a bare access token. */
export function parseStored(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj.accessToken === "string" && obj.accessToken) {
        return {
          v: 2,
          accessToken: obj.accessToken,
          accessExpiresAt: Number.isFinite(obj.accessExpiresAt) ? obj.accessExpiresAt : null,
          refreshToken: typeof obj.refreshToken === "string" && obj.refreshToken ? obj.refreshToken : null,
          refreshExpiresAt: Number.isFinite(obj.refreshExpiresAt) ? obj.refreshExpiresAt : null,
        };
      }
    } catch {
      return null;
    }
    return null;
  }
  return { v: 1, accessToken: text, accessExpiresAt: null, refreshToken: null, refreshExpiresAt: null };
}

export function serialise(cred) {
  return JSON.stringify(cred);
}

export function needsRefresh(cred, now = Date.now()) {
  return Boolean(cred?.refreshToken && cred.accessExpiresAt != null && cred.accessExpiresAt - now <= REFRESH_MARGIN_MS);
}

export function canRefresh(cred, now = Date.now()) {
  return Boolean(cred?.refreshToken && (cred.refreshExpiresAt == null || cred.refreshExpiresAt > now));
}

/** Errors that mean the refresh token itself is dead (reconnect required). */
const DEAD_REFRESH_ERRORS = new Set(["bad_refresh_token", "unauthorized_client", "invalid_grant", "access_denied"]);

/**
 * Exchanges the refresh token for a new credential.
 * Returns { cred } on success, { dead: true } when GitHub rejects the refresh
 * token, or { temporary: true } on network / server problems (never fatal).
 */
export async function refreshCredential(cred, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!canRefresh(cred, now)) return { dead: true };
  let res;
  try {
    res = await fetchImpl(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: cred.refreshToken,
      }),
    });
  } catch {
    return { temporary: true };
  }
  if (!res.ok) return res.status >= 500 || res.status === 429 ? { temporary: true } : { dead: true };
  let body;
  try {
    body = await res.json();
  } catch {
    return { temporary: true };
  }
  if (body?.error) return DEAD_REFRESH_ERRORS.has(body.error) ? { dead: true } : { temporary: true };
  const next = credentialFromResponse(body, now);
  return next ? { cred: next } : { temporary: true };
}

/**
 * Returns a usable access token, refreshing first when it is about to expire.
 * `store` = { read(): string|null, write(string): boolean }.
 * Result: { token, cred } | { token: null, dead } | { token: null } (none stored).
 */
export async function getAccessToken(store, { fetchImpl = fetch, now = Date.now() } = {}) {
  const cred = parseStored(store.read());
  if (!cred) return { token: null };
  if (!needsRefresh(cred, now)) return { token: cred.accessToken, cred };
  const r = await refreshCredential(cred, { fetchImpl, now });
  if (r.cred) {
    if (!store.write(serialise(r.cred))) return { token: null, temporary: true };
    return { token: r.cred.accessToken, cred: r.cred, refreshed: true };
  }
  if (r.dead) return { token: null, dead: true };
  // Temporary refresh failure: try the current token; it may still be valid.
  return { token: cred.accessToken, cred };
}

/** After a 401: refresh once (rotated token saved) or report dead/temporary. */
export async function recoverFromUnauthorized(store, cred, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!cred?.refreshToken) return { dead: true };
  const r = await refreshCredential(cred, { fetchImpl, now });
  if (r.cred) {
    if (!store.write(serialise(r.cred))) return { temporary: true };
    return { token: r.cred.accessToken, cred: r.cred };
  }
  return r;
}
