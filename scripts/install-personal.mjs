#!/usr/bin/env node

/**
 * Copyright 2026 Sendbird, Inc.
 * Modifications copyright 2026 linjunsu.
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ensureNativePluginHooksEnabled } from "./lib/codex-config.mjs";
import { resolveCodexHome } from "./lib/codex-paths.mjs";

const PLUGIN_NAME = "cc";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
const HOME_DIR = os.homedir();
const TARGET_ROOT = path.join(HOME_DIR, "plugins", PLUGIN_NAME);
const MARKETPLACE_FILE = path.join(HOME_DIR, ".agents", "plugins", "marketplace.json");
const CODEX_CONFIG_FILE = path.join(resolveCodexHome(), "config.toml");
const CODEX_BIN = process.platform === "win32" ? "codex.exe" : "codex";

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shouldCopyEntry(sourcePath) {
  const name = path.basename(sourcePath);
  return ![".git", "node_modules"].includes(name);
}

function ensureSourceAtPersonalPath() {
  if (samePath(PACKAGE_ROOT, TARGET_ROOT)) {
    return;
  }

  if (fs.existsSync(TARGET_ROOT)) {
    if (process.env.CC_PLUGIN_CODEX_OVERWRITE !== "1") {
      console.error(`${TARGET_ROOT} already exists.`);
      console.error("Update that checkout directly, or set CC_PLUGIN_CODEX_OVERWRITE=1 to replace it.");
      process.exit(1);
    }
    if (!isWithin(path.join(HOME_DIR, "plugins"), TARGET_ROOT)) {
      throw new Error(`Refusing to replace unexpected path: ${TARGET_ROOT}`);
    }
    fs.rmSync(TARGET_ROOT, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(TARGET_ROOT), { recursive: true });
  fs.cpSync(PACKAGE_ROOT, TARGET_ROOT, {
    recursive: true,
    filter: shouldCopyEntry,
  });
}

function ensurePersonalMarketplaceEntry() {
  const marketplace = readJson(MARKETPLACE_FILE, {
    name: "personal",
    interface: {
      displayName: "Personal",
    },
    plugins: [],
  });

  if (!marketplace || typeof marketplace !== "object") {
    throw new Error(`${MARKETPLACE_FILE} is not a JSON object`);
  }
  marketplace.name = marketplace.name || "personal";
  marketplace.interface = marketplace.interface || { displayName: "Personal" };
  marketplace.interface.displayName = marketplace.interface.displayName || "Personal";
  marketplace.plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];

  const entry = {
    name: PLUGIN_NAME,
    source: {
      source: "local",
      path: "./plugins/cc",
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Coding",
  };

  const existingIndex = marketplace.plugins.findIndex((plugin) => plugin?.name === PLUGIN_NAME);
  if (existingIndex >= 0) {
    marketplace.plugins[existingIndex] = entry;
  } else {
    marketplace.plugins.push(entry);
  }

  writeJson(MARKETPLACE_FILE, marketplace);
}

function ensureHookFeatures() {
  const existing = readText(CODEX_CONFIG_FILE);
  const { changed, content } = ensureNativePluginHooksEnabled(existing);
  if (changed || !fs.existsSync(CODEX_CONFIG_FILE)) {
    writeText(CODEX_CONFIG_FILE, content);
    return true;
  }
  return false;
}

function installPlugin() {
  const result = spawnSync(CODEX_BIN, ["plugin", "add", "cc@personal"], {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    console.error("Run manually after fixing PATH: codex plugin add cc@personal");
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

ensureSourceAtPersonalPath();
ensurePersonalMarketplaceEntry();
const hooksChanged = ensureHookFeatures();
installPlugin();

console.log(`Installed ${PLUGIN_NAME}@personal from ${TARGET_ROOT}.`);
if (hooksChanged) {
  console.log("Enabled [features].hooks and [features].plugin_hooks in Codex config.");
}
console.log("Restart Codex, then run $cc:setup.");
