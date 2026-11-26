#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync, cpSync, renameSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { generateKeyPairSync, privateDecrypt } from "node:crypto";
import { readConfig, writeConfig } from "./config.mjs";
import { resolveDbPath } from "./connectors/opencode.mjs";
import { detect as detectClaudeCode } from "./connectors/claude-code.mjs";
import { syncOnce } from "./sync.mjs";
import * as claudeAllowance from "./connectors/claude-allowance.mjs";
import { readFileSync } from "node:fs";
import { keychainDeleteToken, loginWithDeviceFlow, LoginDeclined } from "./github-device-auth.mjs";
import { runTrackedSync } from './local-status.mjs';
import { menuAppPath, menuAgentPath, writeMenuAgent } from './menu-install.mjs';
import { ensureAgent } from './agent-registration.mjs';
import * as uninstaller from './uninstall.mjs';


const API_BASE = "https://project--90f1947c-aecf-4a7d-b306-1bb570686772.lovable.app";
// Pages opened in the browser must use the published site; the API address
// serves only /api/public/* and answers 403 for normal pages.
const SITE_BASE = "https://ambient-ai-watch.lovable.app";
const APP_LABEL = "app.aiusagemonitor.collector";
const AGENT_PATH = join(homedir(), "Library", "LaunchAgents", `${APP_LABEL}.plist`);
const INSTALLED_EXECUTABLE = join(homedir(), ".aum", "bin", "aum-collector");

function notify(title, message) {
  if (process.platform !== "darwin") return;
  const safeTitle = title.replaceAll('"', "\\\"");
  const safeMessage = message.replaceAll('"', "\\\"");
  try {
    execFileSync("osascript", ["-e", `display notification "${safeMessage}" with title "${safeTitle}"`]);
  } catch {
    // Notifications are optional; status is always visible in the web app.
  }
}

function dialog(script) {
  const res = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : "";
}

/** Native dialog showing the GitHub code (already copied to the clipboard). */
function confirmCode(code) {
  const safe = String(code).replace(/[^A-Z0-9-]/gi, "");
  const out = dialog(
    `display dialog "Connect GitHub Copilot\n\nYour code:   ${safe}\n\nThe code is already copied. Click Continue to GitHub, paste it (Cmd+V), then approve AI Usage Monitor." ` +
      `with title "AI Usage Monitor" buttons {"Not now", "Continue to GitHub"} default button "Continue to GitHub" cancel button "Not now" with icon note giving up after 600`,
  );
  return out.includes("Continue to GitHub") && !out.includes("gave up:true");
}

function showResult(message) {
  const safe = message.replaceAll('"', "'");
  dialog(`display dialog "${safe}" with title "AI Usage Monitor" buttons {"OK"} default button "OK" with icon note giving up after 60`);
}

async function githubLogin({ onWaiting } = {}) {
  try {
    const token = await loginWithDeviceFlow({ openBrowser, notify, confirm: confirmCode, onWaiting });
    showResult("GitHub Copilot is connected. Your allowance will appear on the website shortly.");
    return token;
  } catch (err) {
    if (!(err instanceof LoginDeclined)) {
      showResult(`GitHub Copilot was not connected: ${err instanceof Error ? err.message : "please try again"} You can connect it any time from the website.`);
    }
    throw err;
  }
}

const copilotOptions = (interactive) => ({
  onGitHubLoginNeeded: githubLogin,
  interactive,
  deleteCredential: keychainDeleteToken,
});

function openBrowser(url) {
  execFileSync("open", [url], { stdio: "ignore" });
}

async function pair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const response = await fetch(`${API_BASE}/api/public/collector/pair/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey, deviceLabel: "Mac collector" }),
  });
  if (!response.ok) throw new Error("Could not start secure pairing.");
  const request = await response.json();
  const approvePage = await fetch(request.approveUrl, { redirect: "follow" }).catch(() => null);
  if (!approvePage || !approvePage.ok) {
    throw new Error("The approval page could not be reached. Please try again shortly.");
  }
  openBrowser(request.approveUrl);
  notify("AI Usage Monitor", "Approve this Mac in your browser to continue.");

  while (Date.now() < new Date(request.expiresAt).getTime()) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const claimResponse = await fetch(`${API_BASE}/api/public/collector/pair/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: request.secret }),
    });
    if (claimResponse.status === 202) continue;
    if (!claimResponse.ok) throw new Error("Pairing expired or could not be completed.");
    const claim = await claimResponse.json();
    const token = privateDecrypt(
      { key: privateKey, oaepHash: "sha256" },
      Buffer.from(claim.encryptedToken, "base64"),
    ).toString("utf8");
    writeConfig({ apiBase: API_BASE, token });
    return;
  }
  throw new Error("Pairing expired. Open the collector again to retry.");
}

function installAgent() {
  mkdirSync(dirname(INSTALLED_EXECUTABLE), { recursive: true });
  copyFileSync(process.execPath, `${INSTALLED_EXECUTABLE}.new`);
  renameSync(`${INSTALLED_EXECUTABLE}.new`, INSTALLED_EXECUTABLE);
  chmodSync(INSTALLED_EXECUTABLE, 0o700);
  const executable = INSTALLED_EXECUTABLE;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${APP_LABEL}</string>
<key>ProgramArguments</key><array><string>${executable}</string><string>sync</string></array>
<key>StartInterval</key><integer>900</integer>
<key>RunAtLoad</key><false/>
<key>StandardOutPath</key><string>${join(homedir(), ".aum", "collector.log")}</string>
<key>StandardErrorPath</key><string>${join(homedir(), ".aum", "collector.log")}</string>
</dict></plist>`;
  mkdirSync(dirname(AGENT_PATH), { recursive: true });
  mkdirSync(join(homedir(), ".aum"), { recursive: true });
  ensureAgent(AGENT_PATH, plist, APP_LABEL);
  installPollAgent(executable);
}

/**
 * "Check now" poller: a separate, lightweight agent that asks the website
 * about once a minute whether the user pressed Check now. The 15-minute sync
 * agent above is unchanged.
 */
const POLL_LABEL = `${APP_LABEL}.checknow`;
const POLL_AGENT_PATH = join(homedir(), "Library", "LaunchAgents", `${POLL_LABEL}.plist`);
function installPollAgent(executable) {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${POLL_LABEL}</string>
<key>ProgramArguments</key><array><string>${executable}</string><string>poll</string></array>
<key>StartInterval</key><integer>60</integer>
<key>RunAtLoad</key><false/>
<key>StandardOutPath</key><string>${join(homedir(), ".aum", "collector.log")}</string>
<key>StandardErrorPath</key><string>${join(homedir(), ".aum", "collector.log")}</string>
</dict></plist>`;
  try {
    ensureAgent(POLL_AGENT_PATH, plist, POLL_LABEL);
  } catch (err) { throw new Error('Could not activate Check now background job. Reopen the app to retry.'); }
}

async function trackedSync(interactive, beforeSync) {
  const result = await runTrackedSync(syncOnce, { Database, ...copilotOptions(interactive) }, { beforeSync });
  if (result.busy && !beforeSync) process.exitCode = 75;
  if (result.outcome === 'failed' || result.outcome === 'partial') process.exitCode = 1;
  return result;
}

async function installMenu() {
  const source = dirname(dirname(dirname(process.execPath)));
  if (!source.endsWith('.app') || !existsSync(join(source, 'Contents', 'MacOS', 'AI-Usage-Monitor'))) throw new Error('Open the downloaded AI Usage Monitor app to install the menu bar.');
  const target = menuAppPath();
  mkdirSync(dirname(target), { recursive: true });
  const staging = `${target}.new`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(source, staging, { recursive: true, preserveTimestamps: true });
  // Stop the old interface before replacing its bundle, but never stop sync
  // jobs or remove pairing, credentials, checkpoints or Claude settings.
  try { execFileSync('launchctl', ['unload', menuAgentPath()], { stdio: 'ignore' }); } catch {}
  rmSync(`${target}.old`, { recursive: true, force: true });
  if (existsSync(target)) renameSync(target, `${target}.old`);
  renameSync(staging, target);
  const menuExecutable = join(target, 'Contents', 'MacOS', 'AI-Usage-Monitor');
  writeMenuAgent(menuExecutable);
  try { await firstRun(); } catch (err) {
    // Even offline/setup failure must leave a visible interface for retry.
    execFileSync('launchctl', ['load', menuAgentPath()], { stdio: 'ignore' });
    throw err;
  }
  execFileSync('launchctl', ['load', menuAgentPath()], { stdio: 'ignore' });
  rmSync(`${target}.old`, { recursive: true, force: true });
}

/** Returns true only when the website has a pending Check now request. */
async function checkNowRequested() {
  const config = readConfig();
  if (!config.token) return false;
  try {
    const res = await fetch(`${config.apiBase}/api/public/collector/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}` },
    });
    if (!res.ok) return false;
    return (await res.json()).sync === true;
  } catch {
    return false;
  }
}

/**
 * Asks before touching ~/.claude/settings.json. Only runs when the user
 * opened the app themselves. Declining changes nothing.
 */
function offerClaudeLimits() {
  if (!detectClaudeCode()) return;
  const info = claudeAllowance.inspect();
  if (info.installed || !info.readable) return;
  const keep = info.hasStatusLine ? " Your existing Claude Code status line is kept and keeps working." : " No new status line will appear in Claude Code.";
  const out = dialog(
    `display dialog "Enable Claude subscription limits?\n\nThis adds a small status-line integration to Claude Code so AI Usage Monitor can read your 5-hour and weekly limit percentages.${keep} A backup of your Claude settings is saved first. Only the percentages and reset times are sent — never prompts or code." ` +
      `with title "AI Usage Monitor" buttons {"Not now", "Enable Claude subscription limits"} default button "Enable Claude subscription limits" cancel button "Not now" with icon note giving up after 600`,
  );
  if (!out.includes("Enable Claude subscription limits") || out.includes("gave up:true")) return;
  try {
    claudeAllowance.install(INSTALLED_EXECUTABLE);
    showResult("Claude subscription limits are enabled. They appear on the website after your next Claude Code message (restart open Claude Code sessions first).");
  } catch (err) {
    showResult(`Claude subscription limits were not enabled: ${err instanceof Error ? err.message : "please try again"} Your Claude settings were not changed.`);
  }
}

async function firstRun() {
  if (process.platform !== "darwin") throw new Error("This collector currently requires macOS.");
  const hasOpenCode = Boolean(resolveDbPath(readConfig().openCodeDb));
  if (!hasOpenCode && !detectClaudeCode()) throw new Error("Neither OpenCode nor Claude Code was found on this Mac.");
  if (!readConfig().token) await pair();
  installAgent();
  // The user opened the app: this is an explicit action, so a GitHub
  // connection may be offered once if Copilot is not connected yet.
  await trackedSync(true);
  offerClaudeLimits();
  notify("AI Usage Monitor", "The menu bar shows your readings and check results. Monitoring continues in the background.");
}

function runUninstall() {
  const confirmed = dialog(
    `display dialog "Uninstall AI Usage Monitor from this Mac?\n\nThis removes: the menu bar app, its background checks, its local settings, its GitHub sign-in in Keychain, and its Claude Code status line (your previous setting is restored).\n\nNot touched: your OpenCode, Claude Code, GitHub and VS Code data.\n\nYour online account and usage history stay on the website. You can remove this Mac or delete your account there." ` +
      `with title "Uninstall AI Usage Monitor" buttons {"Cancel", "Uninstall"} default button "Cancel" cancel button "Cancel" with icon caution`,
  );
  if (!confirmed.includes("Uninstall")) return;
  const result = uninstaller.uninstall(uninstaller.paths(homedir()), {
    run: (c, a) => spawnSync(c, a, { encoding: "utf8" }),
    uid: process.getuid?.(),
    deleteKeychain: keychainDeleteToken,
  });
  if (result.ok) {
    showResult("AI Usage Monitor was removed from this Mac. Your online account and history are unchanged.");
    return;
  }
  let where = "";
  try { where = uninstaller.writeDiagnostic(result, homedir()).replace(homedir(), "~"); } catch {}
  const attention = result.steps.filter((s) => s.status === "failed" || s.status === "kept").map((s) => `- ${s.step}: ${s.detail}`).join("\n");
  showResult(`Uninstall finished, but some items were left untouched for safety:\n${attention}\n\nYou can run Uninstall again, or remove these items yourself.${where ? ` Details: ${where}` : ""}`);
  process.exitCode = 1;
}

if (process.argv[2] === claudeAllowance.SHIM_ARG) {
  // Status-line shim: must be fast, silent and never fail Claude Code.
  let input = "";
  try {
    input = readFileSync(0, "utf8");
  } catch {}
  const res = claudeAllowance.runShim(input);
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  process.exit(res.status);
}

// Under Bun's compiled loader argv positions can shift; match by name so a
// background run can never fall into the interactive first-run path.
const KNOWN = ["uninstall", "install-menu", "menu-sync", "disable-claude-limits", "poll", "sync", "disconnect-github"];
const cmd = process.argv.slice(1).find((a) => KNOWN.includes(a)) ?? null;

try {
  if (cmd === "uninstall") runUninstall();
  else if (cmd === "install-menu") await installMenu();
  else if (cmd === "disable-claude-limits") {
    console.log(claudeAllowance.restore().changed ? "Claude status line restored." : "Nothing to restore.");
  } else if (cmd === "poll") {
    await trackedSync(false, checkNowRequested);
  } else if (cmd === "sync" || cmd === "menu-sync") await trackedSync(false);
  else if (cmd === "disconnect-github") {
    const removed = keychainDeleteToken();
    console.log(removed ? "GitHub credential removed from the macOS Keychain." : "No stored GitHub credential found.");
  } else await firstRun();
} catch (error) {
  const message = error instanceof Error ? error.message : "Collector setup failed.";
  if (!cmd || cmd === 'install-menu') {
    notify("AI Usage Monitor", message);
    openBrowser(`${SITE_BASE}/collector?collectorError=${encodeURIComponent(message)}`);
  }
  process.exitCode = 1;
}
