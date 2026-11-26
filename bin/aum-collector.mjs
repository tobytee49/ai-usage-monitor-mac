#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readConfig, writeConfig, CONFIG_PATH, DEFAULT_API_BASE } from "../src/config.mjs";
import { resolveDbPath } from "../src/connectors/opencode.mjs";
import { syncOnce } from "../src/sync.mjs";

const AGENT_LABEL = "app.aiusagemonitor.collector";
const AGENT_PATH = join(homedir(), "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
// Derived from argv rather than import.meta so this file can also be served
// verbatim by the installer without the bundler rewriting it.
const here = dirname(
  process.argv[1]?.startsWith("file:") ? fileURLToPath(process.argv[1]) : process.argv[1] ?? ".",
);

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function login() {
  const rl = createInterface({ input: stdin, output: stdout });
  const token = (await rl.question("Pairing key (from Settings): ")).trim();
  const apiBaseAnswer = (await rl.question(`API URL [${DEFAULT_API_BASE}]: `)).trim();
  rl.close();

  if (!token.startsWith("aum_")) fail("That doesn't look like a pairing key.");
  writeConfig({ token, apiBase: apiBaseAnswer || DEFAULT_API_BASE });
  console.log(`✓ Saved to ${CONFIG_PATH} (readable only by you). The key is never printed again.`);
}

function status() {
  const config = readConfig();
  const dbPath = resolveDbPath(config.openCodeDb);
  console.log(`API URL:      ${config.apiBase}`);
  console.log(`Pairing key:  ${config.token ? "saved" : "not set — run `aum-collector login`"}`);
  console.log(`OpenCode DB:  ${dbPath ?? "not found — run `aum-collector set-db <path>`"}`);
  console.log(`Interval:     every ${config.intervalMinutes} minutes`);
}

function installAgent() {
  if (process.platform !== "darwin") fail("Background scheduling is macOS-only for now.");
  const config = readConfig();
  const seconds = Math.max(60, Math.round(config.intervalMinutes * 60));
  const script = join(here, "aum-collector.mjs");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${script}</string>
    <string>sync</string>
  </array>
  <key>StartInterval</key><integer>${seconds}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${join(homedir(), ".aum", "collector.log")}</string>
  <key>StandardErrorPath</key><string>${join(homedir(), ".aum", "collector.log")}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(AGENT_PATH), { recursive: true });
  mkdirSync(join(homedir(), ".aum"), { recursive: true });
  writeFileSync(AGENT_PATH, plist);
  try {
    execFileSync("launchctl", ["unload", AGENT_PATH], { stdio: "ignore" });
  } catch {
    // not loaded yet
  }
  execFileSync("launchctl", ["load", AGENT_PATH]);
  console.log(`✓ Background sync installed (every ${config.intervalMinutes} min).`);
}

function uninstallAgent() {
  if (!existsSync(AGENT_PATH)) return console.log("Background sync was not installed.");
  try {
    execFileSync("launchctl", ["unload", AGENT_PATH], { stdio: "ignore" });
  } catch {
    // ignore
  }
  rmSync(AGENT_PATH);
  console.log("✓ Background sync removed.");
}

/**
 * Non-interactive one-shot setup: pair, find OpenCode, sync, keep syncing.
 * Reads AUM_TOKEN / AUM_API_BASE from the environment so the whole local
 * setup is a single copied command.
 */
async function setup() {
  const env = readConfig();
  if (!env.token) fail("No pairing key. Copy the setup command again from the Collector page.");
  writeConfig({ token: env.token, apiBase: env.apiBase });
  console.log("✓ Paired with your account (key stored in ~/.aum/config.json, readable only by you).");

  const dbPath = resolveDbPath(env.openCodeDb);
  if (!dbPath) {
    fail(
      "Could not find OpenCode's local database. Run:\n" +
        "  node ~/.aum/collector/bin/aum-collector.mjs set-db <path to opencode.db>\n" +
        "  node ~/.aum/collector/bin/aum-collector.mjs setup",
    );
  }
  console.log("✓ Found OpenCode.");

  await syncOnce();

  if (process.platform === "darwin") {
    try {
      installAgent();
    } catch (error) {
      console.warn(`! Background sync could not be installed: ${error.message}`);
    }
  } else {
    console.log("· Background sync is macOS-only for now — run `sync` again any time.");
  }

  console.log("✓ Done. OpenCode now shows as connected in AI Usage Monitor.");
}

async function watch() {
  const { intervalMinutes } = readConfig();
  console.log(`Watching — syncing every ${intervalMinutes} minutes. Ctrl+C to stop.`);
  for (;;) {
    try {
      await syncOnce();
    } catch (error) {
      console.error(`✗ ${error.message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMinutes * 60_000));
  }
}

const [command, arg] = process.argv.slice(2);

try {
  switch (command) {
    case "login":
      await login();
      break;
    case "set-db":
      if (!arg) fail("Usage: aum-collector set-db <path to opencode.db>");
      writeConfig({ openCodeDb: arg });
      console.log("✓ OpenCode database path saved.");
      break;
    case "setup":
      await setup();
      break;
    case "sync":
      await syncOnce();
      break;
    case "statusline": {
      const { runShim } = await import("../src/connectors/claude-allowance.mjs");
      const { readFileSync } = await import("node:fs");
      let input = "";
      try { input = readFileSync(0, "utf8"); } catch {}
      const res = runShim(input);
      process.stdout.write(res.stdout);
      process.stderr.write(res.stderr);
      process.exit(res.status);
    }
    case "watch":
      await watch();
      break;
    case "install-agent":
      installAgent();
      break;
    case "uninstall-agent":
      uninstallAgent();
      break;
    case "status":
      status();
      break;
    default:
      console.log(
        [
          "AI Usage Monitor collector",
          "",
          "  aum-collector setup             Pair, find OpenCode, sync and keep syncing",
          "  aum-collector login             Save your pairing key",
          "  aum-collector sync              Sync new usage once",
          "  aum-collector watch             Sync on an interval in the foreground",
          "  aum-collector install-agent     Run quietly in the background (macOS)",
          "  aum-collector uninstall-agent   Stop background syncing",
          "  aum-collector set-db <path>     Point at OpenCode's database",
          "  aum-collector status            Show current configuration",
        ].join("\n"),
      );
  }
} catch (error) {
  fail(error.message);
}
