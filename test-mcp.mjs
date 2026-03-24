import { spawn } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";

const body = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" }
  }
});

const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
const request = header + body;

const inputFile = "C:\\Users\\yaolin\\AppData\\Local\\Temp\\mcp_in.txt";
const outputFile = "C:\\Users\\yaolin\\AppData\\Local\\Temp\\mcp_out.txt";
const errorFile = "C:\\Users\\yaolin\\AppData\\Local\\Temp\\mcp_err.txt";

writeFileSync(inputFile, request);

const child = spawn("node", ["src/index.js"], {
  cwd: "C:\\Users\\yaolin\\Documents\\codex_projects\\boss-recruit-mcp",
  stdio: ["pipe", "pipe", "pipe"]
});

child.stdin.write(request);
child.stdin.end();

setTimeout(() => {
  if (!child.killed) {
    child.kill();
    console.log("Process killed after timeout");
  }
}, 3000);

child.stdout.on("data", (chunk) => {
  console.log("STDOUT:", chunk.toString());
});

child.stderr.on("data", (chunk) => {
  console.log("STDERR:", chunk.toString());
});

child.on("close", (code) => {
  console.log("Exit code:", code);
});
