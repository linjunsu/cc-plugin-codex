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

const PLUGIN_NAME = "cc";
const HOME_DIR = os.homedir();
const MARKETPLACE_FILE = path.join(HOME_DIR, ".agents", "plugins", "marketplace.json");
const CODEX_BIN = process.platform === "win32" ? "codex.exe" : "codex";

function uninstallPlugin() {
  const result = spawnSync(CODEX_BIN, ["plugin", "remove", "cc@personal"], {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
  }
}

function removeMarketplaceEntry() {
  if (!fs.existsSync(MARKETPLACE_FILE)) {
    return;
  }
  const marketplace = JSON.parse(fs.readFileSync(MARKETPLACE_FILE, "utf8"));
  if (!marketplace || typeof marketplace !== "object" || !Array.isArray(marketplace.plugins)) {
    return;
  }
  const nextPlugins = marketplace.plugins.filter((plugin) => plugin?.name !== PLUGIN_NAME);
  if (nextPlugins.length === marketplace.plugins.length) {
    return;
  }
  marketplace.plugins = nextPlugins;
  fs.writeFileSync(MARKETPLACE_FILE, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
}

uninstallPlugin();
removeMarketplaceEntry();
console.log("Removed cc@personal from Codex and the personal marketplace entry.");
