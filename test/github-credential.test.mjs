import { describe, expect, test } from "bun:test";
import {
  credentialFromResponse,
  getAccessToken,
  parseStored,
  recoverFromUnauthorized,
  refreshCredential,
  serialise,
} from "../src/github-credential.mjs";

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;

function memStore(initial) {
  const s = { value: initial, writes: 0 };
  return { s, read: () => s.value, write: (v) => ((s.value = v), s.writes++, true) };
}
function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
const cred = (over = {}) => ({
  v: 2, accessToken: "A1", accessExpiresAt: NOW + 8 * HOUR, refreshToken: "R1", refreshExpiresAt: NOW + 180 * 24 * HOUR, ...over,
});

describe("GitHub credential refresh", () => {
  test("initial connect stores access + refresh token with expiries", () => {
    const c = credentialFromResponse({ access_token: "A", expires_in: 28800, refresh_token: "R", refresh_token_expires_in: 15897600 }, NOW);
    expect(c).toEqual({ v: 2, accessToken: "A", accessExpiresAt: NOW + 28800_000, refreshToken: "R", refreshExpiresAt: NOW + 15897600_000 });
    expect(parseStored(serialise(c))).toEqual(c);
  });

  test("legacy bare token still reads as access-token-only", () => {
    expect(parseStored("ghu_legacy")).toEqual({ v: 1, accessToken: "ghu_legacy", accessExpiresAt: null, refreshToken: null, refreshExpiresAt: null });
  });

  test("valid token is used without any network call", async () => {
    const store = memStore(serialise(cred()));
    const r = await getAccessToken(store, { now: NOW, fetchImpl: () => { throw new Error("no network"); } });
    expect(r.token).toBe("A1");
    expect(store.s.writes).toBe(0);
  });

  test("near-expiry triggers refresh, sends client ID only, and saves rotated refresh token", async () => {
    const store = memStore(serialise(cred({ accessExpiresAt: NOW + 5 * 60_000 })));
    let sent;
    const fetchImpl = async (_url, init) => {
      sent = Object.fromEntries(init.body);
      return jsonRes(200, { access_token: "A2", expires_in: 28800, refresh_token: "R2", refresh_token_expires_in: 15897600 });
    };
    const r = await getAccessToken(store, { now: NOW, fetchImpl });
    expect(r.token).toBe("A2");
    expect(sent).toEqual({ client_id: "Iv23liPKSmWq5mgNQHdx", grant_type: "refresh_token", refresh_token: "R1" });
    expect(sent.client_secret).toBeUndefined();
    expect(parseStored(store.s.value).refreshToken).toBe("R2");
  });

  test("network failure during refresh keeps the credential", async () => {
    const original = serialise(cred({ accessExpiresAt: NOW - 1 }));
    const store = memStore(original);
    const r = await getAccessToken(store, { now: NOW, fetchImpl: async () => { throw new Error("offline"); } });
    expect(r.dead).toBeUndefined();
    expect(store.s.value).toBe(original);
  });

  test("GitHub 5xx is temporary, not dead", async () => {
    expect(await refreshCredential(cred(), { now: NOW, fetchImpl: async () => jsonRes(502, {}) })).toEqual({ temporary: true });
  });

  test("bad_refresh_token means reconnect required", async () => {
    const store = memStore(serialise(cred({ accessExpiresAt: NOW - 1 })));
    const r = await getAccessToken(store, { now: NOW, fetchImpl: async () => jsonRes(200, { error: "bad_refresh_token" }) });
    expect(r).toEqual({ token: null, dead: true });
  });

  test("expired refresh token is dead without a network call", async () => {
    const r = await refreshCredential(cred({ refreshExpiresAt: NOW - 1 }), { now: NOW, fetchImpl: () => { throw new Error("no"); } });
    expect(r).toEqual({ dead: true });
  });

  test("401 → refresh → new token returned and saved", async () => {
    const store = memStore(serialise(cred()));
    const r = await recoverFromUnauthorized(store, cred(), {
      now: NOW,
      fetchImpl: async () => jsonRes(200, { access_token: "A3", expires_in: 28800, refresh_token: "R3", refresh_token_expires_in: 100 }),
    });
    expect(r.token).toBe("A3");
    expect(parseStored(store.s.value).refreshToken).toBe("R3");
  });

  test("401 with a legacy token (no refresh token) is dead", async () => {
    expect(await recoverFromUnauthorized(memStore("x"), parseStored("ghu_x"))).toEqual({ dead: true });
  });
});
