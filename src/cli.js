import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startServer } from "./index.js";

const currentFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(currentFilePath), "..");
const skillSourceDir = path.join(packageRoot, "skills", "boss-recruit-pipeline");
const exampleConfigPath = path.join(packageRoot, "config", "screening-config.example.json");

function getCodexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function installSkill() {
  const codexHome = getCodexHome();
  const targetDir = path.join(codexHome, "skills", "boss-recruit-pipeline");
  ensureDir(path.dirname(targetDir));
  fs.cpSync(skillSourceDir, targetDir, { recursive: true, force: true });
  return targetDir;
}

function ensureUserConfig() {
  const targetDir = path.join(getCodexHome(), "boss-recruit-mcp");
  const targetPath = path.join(targetDir, "screening-config.json");
  ensureDir(targetDir);
  if (!fs.existsSync(targetPath)) {
    fs.copyFileSync(exampleConfigPath, targetPath);
    return { path: targetPath, created: true };
  }
  return { path: targetPath, created: false };
}

function printHelp() {
  console.log("boss-recruit-mcp");
  console.log("");
  console.log("Usage:");
  console.log("  boss-recruit-mcp              Start the MCP server");
  console.log("  boss-recruit-mcp start        Start the MCP server");
  console.log("  boss-recruit-mcp install      Install Codex skill and initialize user config");
  console.log("  boss-recruit-mcp install-skill Install only the Codex skill");
  console.log("  boss-recruit-mcp init-config  Create ~/.codex/boss-recruit-mcp/screening-config.json if missing");
  console.log("  boss-recruit-mcp where        Print installed package, skill, and config paths");
}

function printPaths() {
  const codexHome = getCodexHome();
  console.log(`package_root=${packageRoot}`);
  console.log(`skill_source=${skillSourceDir}`);
  console.log(`codex_home=${codexHome}`);
  console.log(`skill_target=${path.join(codexHome, "skills", "boss-recruit-pipeline")}`);
  console.log(`config_target=${path.join(codexHome, "boss-recruit-mcp", "screening-config.json")}`);
}

function installAll() {
  const skillTarget = installSkill();
  const configResult = ensureUserConfig();
  console.log(`Skill installed to: ${skillTarget}`);
  if (configResult.created) {
    console.log(`Config template created at: ${configResult.path}`);
  } else {
    console.log(`Config already exists at: ${configResult.path}`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("1. Fill in baseUrl/apiKey/model in the config file above.");
  console.log("2. Start Chrome with --remote-debugging-port=9222 and log in to Boss.");
  console.log("3. Run `boss-recruit-mcp start` or configure your MCP client to launch `boss-recruit-mcp`.");
}

const command = process.argv[2] || "start";

switch (command) {
  case "start":
    startServer();
    break;
  case "install":
    installAll();
    break;
  case "install-skill":
    console.log(`Skill installed to: ${installSkill()}`);
    break;
  case "init-config": {
    const result = ensureUserConfig();
    console.log(
      result.created
        ? `Config template created at: ${result.path}`
        : `Config already exists at: ${result.path}`
    );
    break;
  }
  case "where":
    printPaths();
    break;
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Run `boss-recruit-mcp --help` for usage.");
    process.exitCode = 1;
}
