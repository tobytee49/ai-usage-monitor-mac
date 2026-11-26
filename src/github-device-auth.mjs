import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { credentialFromResponse, parseStored, serialise } from "./github-credential.mjs";

/**
 * Our own GitHub device-authorisation login (LOCAL ONLY).
 *
 * Uses the OAuth Device Authorization Flow against our registered GitHub App.
 * The resulting user token is stored ONLY in the user's macOS Keychain under
 * our own service entry. It is never printed, never logged, never passed as
 * a command-line argument, never written to a file, and never sent anywhere
 * except github.com / api.github.com.
 */

// Public client ID of the "AI Usage Monitor" GitHub App. Not a secret.
const CLIENT_ID = "Iv23liPKSmWq5mgNQHdx";
const KEYCHAIN_SERVICE = "ai-usage-monitor-github";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

function keychainAccount() {
  // os.userInfo works under launchd, where `id` may not be on PATH.
  try {
    const user = userInfo().username;
    if (user) return user;
  } catch {}
  const user = spawnSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).stdout?.trim();
  return user || "collector";
}

/** Store the token in the login Keychain; it travels via stdin to
 *  `security -i`, never as a command-line argument. */
export function keychainStore(token) {
  // Hex-encoded (-X) so JSON quotes need no escaping; still sent via stdin.
  const hex = Buffer.from(String(token), "utf8").toString("hex");
  const res = spawnSync("security", ["-i"], {
    input: `add-generic-password -U -a "${keychainAccount()}" -s "${KEYCHAIN_SERVICE}" -X ${hex}\n`,
    encoding: "utf8",
  });
  return res.status === 0;
}

/** Returns the raw stored value (JSON credential or legacy bare token). */
export function keychainReadRaw() {
  if (process.platform !== "darwin") return null;
  try {
    const res = spawnSync(
      "security",
      ["find-generic-password", "-a", keychainAccount(), "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8" },
    );
    if (res.status !== 0) return null;
    const token = res.stdout.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Returns the stored access token, or null when none exists. */
export function keychainReadToken() {
  return parseStored(keychainReadRaw())?.accessToken ?? null;
}

/** Keychain-backed store used by the credential refresh logic. */
export const keychainStoreAdapter = { read: () => keychainReadRaw(), write: (v) => keychainStore(v) };

/** Removes our Keychain entry. Returns true when an entry was deleted. */
export function keychainDeleteToken() {
  if (process.platform !== "darwin") return false;
  try {
    const res = spawnSync(
      "security",
      ["delete-generic-password", "-a", keychainAccount(), "-s", KEYCHAIN_SERVICE],
      { encoding: "utf8" },
    );
    return res.status === 0;
  } catch {
    return false;
  }
}

async function postForm(url, fields) {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  if (!res.ok) throw new Error(`GitHub responded with HTTP ${res.status}`);
  return res.json();
}

/**
 * Runs the device-authorisation flow: opens the browser, shows the short
 * code, waits for approval, and stores the token in the Keychain.
 *
 * Returns the token on success. Throws with a user-readable message on
 * decline, expiry or network failure. Never throws the token around in
 * errors and never logs it.
 */
export class LoginDeclined extends Error {}

export async function loginWithDeviceFlow({
  openBrowser,
  notify,
  confirm,
  onWaiting,
  log = () => {},
} = {}) {
  const dc = await postForm(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: "read:user" });
  if (!dc.device_code || !dc.user_code || !dc.verification_uri) {
    throw new Error("GitHub did not start device login. Please try again.");
  }

  log("GitHub connection: waiting for the user to approve in the browser.");
  // Put the code on the clipboard (the code is not a credential — it only
  // identifies this login attempt and expires quickly).
  try {
    spawnSync("pbcopy", [], { input: dc.user_code, encoding: "utf8" });
  } catch {
    // Clipboard is a convenience; the dialog shows the code too.
  }
  // Native dialog showing the code. The user chooses to continue or not.
  if (confirm) {
    const proceed = await confirm(dc.user_code);
    if (!proceed) throw new LoginDeclined("You chose not to connect GitHub Copilot right now.");
  } else {
    notify?.("AI Usage Monitor", `Connect GitHub: enter code ${dc.user_code} in your browser.`);
  }
  try {
    openBrowser?.(dc.verification_uri_complete || dc.verification_uri);
  } catch {
    // The code is on the clipboard and was shown in the dialog.
  }
  await onWaiting?.();

  const deadline = Date.now() + Math.min(dc.expires_in ?? 900, 900) * 1000;
  let interval = Math.max(dc.interval ?? 5, 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const poll = await postForm(ACCESS_TOKEN_URL, {
      client_id: CLIENT_ID,
      device_code: dc.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (poll.access_token) {
      const cred = credentialFromResponse(poll);
      if (!cred || !keychainStore(serialise(cred))) {
        throw new Error("Could not save the GitHub credential to the macOS Keychain.");
      }
      log("GitHub connected. Credential saved to the macOS Keychain.");
      notify?.("AI Usage Monitor", "GitHub is connected.");
      return poll.access_token;
    }
    if (poll.error === "slow_down") interval += 5000;
    else if (poll.error === "expired_token") throw new Error("The GitHub code expired.");
    else if (poll.error === "access_denied") throw new Error("GitHub connection was declined.");
    else if (poll.error && poll.error !== "authorization_pending") {
      throw new Error("GitHub connection failed. Please try again.");
    }
  }
  throw new Error("Timed out waiting for GitHub approval.");
}
