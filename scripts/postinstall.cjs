#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function isGlobalInstall() {
  if (String(process.env.npm_config_global || "").toLowerCase() === "true") return true;
  if (String(process.env.npm_config_location || "").toLowerCase() === "global") return true;

  const argvRaw = String(process.env.npm_config_argv || "");
  if (argvRaw.includes("--global") || argvRaw.includes(" -g ")) return true;

  return false;
}

function main() {
  if (!isGlobalInstall()) {
    return;
  }

  const cliPath = path.join(__dirname, "..", "src", "cli.js");
  if (!fs.existsSync(cliPath)) {
    return;
  }

  const result = spawnSync(process.execPath, [cliPath, "install"], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    windowsHide: true,
    shell: false
  });

  if (result.error) {
    console.warn(`[boss-recruit-mcp] postinstall warning: ${result.error.message}`);
    return;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    console.warn(`[boss-recruit-mcp] postinstall warning: install exited with code ${result.status}`);
  }
}

main();
