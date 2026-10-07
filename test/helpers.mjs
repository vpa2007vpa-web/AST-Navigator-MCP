/**
 * Shared helpers for the test suites. Not a test file itself: `npm test` only
 * runs files matching `test/*.test.mjs`.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const serverEntry = path.join(projectRoot, "dist", "index.js");

/** Lets pending stream callbacks and `setImmediate` work run. */
export const tick = () => new Promise((resolve) => setImmediate(resolve));

export const textOf = (result) => result.content.map((item) => item.text).join("\n");
export const firstLineOf = (result) => textOf(result).split("\n")[0];

export const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
};

/** Spawns the compiled server and connects an SDK client to it over stdio. */
export async function connectClient(args) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, ...args],
    stderr: "pipe",
  });
  const client = new Client({ name: "ast-navigator-tests", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/**
 * Spawns the compiled server and drives its stdio by hand, so tests can send
 * bytes no well-behaved client would. stdout is parsed line by line; anything
 * that is not JSON is kept apart so tests can assert the channel stays clean.
 */
export function spawnRawServer(args = []) {
  const child = spawn(process.execPath, [serverEntry, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const nonJsonLines = [];
  let stdoutBuffer = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      try {
        messages.push(JSON.parse(line));
      } catch {
        nonJsonLines.push(line);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  // 'close' fires after the process exited *and* its stdio streams were flushed.
  const closed = new Promise((resolve) => child.once("close", (code) => resolve(code)));

  return {
    child,
    messages,
    nonJsonLines,
    get stderr() {
      return stderr;
    },
    write: (raw) => child.stdin.write(raw),
    send: (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`),
    async waitFor(predicate, label, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = messages.find(predicate);
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for: ${label}`);
    },
    /** Closes stdin (ends the session) and resolves with the exit code. */
    async stop() {
      child.stdin.end();
      return closed;
    },
  };
}
