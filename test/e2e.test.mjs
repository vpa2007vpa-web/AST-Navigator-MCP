/**
 * End-to-end tests: the compiled server (dist/index.js) is spawned as a real
 * child process and driven over stdio, exactly like an MCP client would.
 *
 * Run with: npm test   (builds first, then uses Node's built-in test runner)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(projectRoot, "dist", "index.js");
const fixtureRepo = path.join(projectRoot, "test", "fixtures", "sample-repo");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Copies the fixture repo to a temp dir and adds decoys that must never be scanned. */
async function createWorkspace() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "ast-navigator-")));
  const repo = path.join(base, "repo");
  await cp(fixtureRepo, repo, { recursive: true });

  await mkdir(path.join(repo, "node_modules", "fake-lib"), { recursive: true });
  await writeFile(path.join(repo, "node_modules", "fake-lib", "index.js"), "export class UserService {}\n");
  await mkdir(path.join(repo, "dist"), { recursive: true });
  await writeFile(path.join(repo, "dist", "bundle.js"), "export function createUserService() {}\n");
  await mkdir(path.join(repo, ".cache"), { recursive: true });
  await writeFile(path.join(repo, ".cache", "UserService.ts"), "export class UserService {}\n");
  await writeFile(path.join(repo, "src", "vendor.min.js"), "function createUserService(){}\n");

  const outsideFile = path.join(base, "outside.ts");
  await writeFile(outsideFile, "export const secret = 1;\n");
  return { base, repo, outsideFile };
}

async function connectClient(args) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, ...args],
    stderr: "pipe",
  });
  const client = new Client({ name: "ast-navigator-e2e", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

const textOf = (result) => result.content.map((item) => item.text).join("\n");

// ---------------------------------------------------------------------------
// Sandboxed server (fixture repo as allowed root)
// ---------------------------------------------------------------------------

describe("sandboxed server", () => {
  let workspace;
  let client;
  const repoFile = (...segments) => path.join(workspace.repo, ...segments);

  before(async () => {
    workspace = await createWorkspace();
    client = await connectClient([workspace.repo]);
  });

  after(async () => {
    await client?.close();
    await rm(workspace.base, { recursive: true, force: true });
  });

  test("advertises exactly the three read-only tools with input and output schemas", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["analyze_dependencies", "find_definition", "get_file_structure"]);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.ok(tool.outputSchema, `${tool.name} must publish an outputSchema`);
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} input must be strict`);
    }
    const getFileStructure = tools.find((tool) => tool.name === "get_file_structure");
    assert.deepEqual(getFileStructure.inputSchema.required, ["filePath"]);
  });

  test("get_file_structure: TypeScript class, imports, functions and types", async () => {
    const result = await client.callTool({
      name: "get_file_structure",
      arguments: { filePath: repoFile("src", "services", "UserService.ts") },
    });
    assert.equal(result.isError, undefined);
    const structure = result.structuredContent;

    assert.equal(structure.language, "typescript");
    assert.equal(structure.hasSyntaxErrors, false);
    assert.deepEqual(
      structure.imports.map((entry) => [entry.source, entry.kind, entry.typeOnly]),
      [
        ["node:crypto", "esm", false],
        ["../models/user.js", "esm", true],
        ["../db/Repository.js", "esm", false],
      ],
    );

    const [userService] = structure.classes;
    assert.equal(userService.name, "UserService");
    assert.equal(userService.exported, true);
    assert.equal(userService.extends, "Repository<User>");
    assert.deepEqual(userService.implements, ["Disposable"]);
    assert.deepEqual(
      userService.methods.map((method) => [method.name, method.kind]),
      [
        ["constructor", "constructor"],
        ["create", "method"],
        ["findById", "method"],
        ["size", "getter"],
        ["[Symbol.dispose]", "method"],
      ],
    );
    const create = userService.methods.find((method) => method.name === "create");
    assert.equal(create.async, true);
    assert.equal(create.signature, "(input: CreateUserInput): Promise<User>");
    assert.deepEqual([create.startLine, create.endLine], [19, 23]);
    assert.deepEqual(
      userService.properties.map((property) => [property.name, property.static, property.readonly, property.visibility]),
      [
        ["cache", false, true, "private"],
        ["instances", true, false, undefined],
      ],
    );

    assert.deepEqual(
      structure.functions.map((fn) => [fn.name, fn.exported, fn.signature]),
      [["createUserService", true, "(options: UserServiceOptions): UserService"]],
    );
    assert.deepEqual(structure.types.map((type) => [type.name, type.kind]), [["UserServiceOptions", "interface"]]);

    const text = textOf(result);
    assert.match(text, /export class UserService extends Repository<User> implements Disposable/);
    assert.match(text, /L19-23 async create\(input: CreateUserInput\): Promise<User>/);
  });

  test("get_file_structure: relative paths resolve against the first root", async () => {
    const result = await client.callTool({ name: "get_file_structure", arguments: { filePath: "src/models/user.ts" } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(
      result.structuredContent.types.map((type) => [type.name, type.kind]),
      [
        ["User", "interface"],
        ["CreateUserInput", "type_alias"],
        ["Role", "enum"],
      ],
    );
  });

  test("get_file_structure: CommonJS module with require and module.exports", async () => {
    const result = await client.callTool({ name: "get_file_structure", arguments: { filePath: repoFile("src", "utils", "math.js") } });
    const structure = result.structuredContent;
    assert.equal(structure.language, "javascript");
    assert.deepEqual(
      structure.imports.map((entry) => [entry.source, entry.kind, entry.specifiers.map((s) => s.name)]),
      [
        ["node:path", "commonjs", ["path"]],
        ["node:fs", "commonjs", ["read", "existsSync"]],
      ],
    );
    assert.deepEqual(
      structure.functions.map((fn) => [fn.name, fn.kind, fn.exported]),
      [
        ["add", "function", true],
        ["multiply", "arrow", true],
        ["internalHelper", "function", false],
        ["version", "arrow", true],
      ],
    );
    const [calculator] = structure.classes;
    assert.equal(calculator.exported, true);
    assert.deepEqual(calculator.properties.map((property) => [property.name, property.visibility]), [["#memory", "private"]]);
    assert.deepEqual(calculator.methods.map((method) => [method.name, method.static]), [
      ["create", true],
      ["store", false],
    ]);
  });

  test("get_file_structure: TSX components", async () => {
    const result = await client.callTool({
      name: "get_file_structure",
      arguments: { filePath: repoFile("src", "components", "Button.tsx"), responseFormat: "json" },
    });
    const parsedText = JSON.parse(textOf(result));
    assert.deepEqual(parsedText, result.structuredContent, "json text must mirror structuredContent");
    assert.equal(parsedText.language, "tsx");
    assert.deepEqual(
      parsedText.functions.map((fn) => [fn.name, fn.kind, fn.exported, fn.defaultExport]),
      [
        ["Button", "arrow", true, false],
        ["App", "function", true, true],
      ],
    );
  });

  test("get_file_structure: syntax errors are reported, not fatal", async () => {
    const result = await client.callTool({ name: "get_file_structure", arguments: { filePath: repoFile("src", "legacy", "broken.ts") } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.hasSyntaxErrors, true);
    assert.ok(result.structuredContent.syntaxErrorLines.length > 0);
    assert.ok(result.structuredContent.functions.some((fn) => fn.name === "ok"));
    assert.match(textOf(result), /Warning: syntax errors/);
  });

  test("get_file_structure: input validation (extension, strict object, empty path)", async () => {
    const unsupported = await client.callTool({ name: "get_file_structure", arguments: { filePath: repoFile("README.md") } });
    assert.equal(unsupported.isError, true);
    assert.match(textOf(unsupported), /Unsupported file extension/);

    const extraField = await client.callTool({
      name: "get_file_structure",
      arguments: { filePath: repoFile("src", "index.mjs"), unexpected: true },
    });
    assert.equal(extraField.isError, true);

    const empty = await client.callTool({ name: "get_file_structure", arguments: { filePath: "   " } });
    assert.equal(empty.isError, true);

    const wrongType = await client.callTool({ name: "get_file_structure", arguments: { filePath: 42 } });
    assert.equal(wrongType.isError, true);
  });

  test("get_file_structure: missing file and sandbox escape produce actionable errors", async () => {
    const missing = await client.callTool({ name: "get_file_structure", arguments: { filePath: repoFile("src", "nope.ts") } });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /^Error \[FILE_NOT_FOUND\]/);
    assert.match(textOf(missing), /Hint:/);

    const outside = await client.callTool({ name: "get_file_structure", arguments: { filePath: workspace.outsideFile } });
    assert.equal(outside.isError, true);
    assert.match(textOf(outside), /^Error \[PATH_OUTSIDE_ROOTS\]/);

    const traversal = await client.callTool({ name: "get_file_structure", arguments: { filePath: "../outside.ts" } });
    assert.equal(traversal.isError, true);
    assert.match(textOf(traversal), /^Error \[PATH_OUTSIDE_ROOTS\]/);
  });

  test("find_definition: exact class lookup skips node_modules, dist, dot-dirs and minified files", async () => {
    const result = await client.callTool({ name: "find_definition", arguments: { name: "UserService" } });
    const output = result.structuredContent;
    assert.equal(output.directory, workspace.repo);
    assert.equal(output.total, 1);
    assert.equal(output.results[0].kind, "class");
    assert.equal(output.results[0].filePath, repoFile("src", "services", "UserService.ts"));
    assert.deepEqual([output.results[0].startLine, output.results[0].endLine], [10, 36]);
    assert.ok(output.filesScanned >= 7);
    assert.ok(output.filesParsed < output.filesScanned, "text pre-filter should avoid parsing unrelated files");
  });

  test("find_definition: qualified method names", async () => {
    const result = await client.callTool({ name: "find_definition", arguments: { name: "UserService.create" } });
    const output = result.structuredContent;
    assert.equal(output.total, 1);
    assert.deepEqual(
      [output.results[0].kind, output.results[0].container, output.results[0].signature],
      ["method", "UserService", "(input: CreateUserInput): Promise<User>"],
    );
  });

  test("find_definition: prefix search ranks exact matches first and honours kinds", async () => {
    const result = await client.callTool({ name: "find_definition", arguments: { name: "create", matchMode: "prefix" } });
    const output = result.structuredContent;
    assert.deepEqual(
      output.results.map((definition) => definition.qualifiedName),
      ["Repository.create", "UserService.create", "Calculator.create", "createUserService"],
    );

    const onlyFunctions = await client.callTool({
      name: "find_definition",
      arguments: { name: "create", matchMode: "prefix", kinds: ["function"] },
    });
    assert.deepEqual(
      onlyFunctions.structuredContent.results.map((definition) => definition.qualifiedName),
      ["createUserService"],
    );
  });

  test("find_definition: case-insensitive substring search", async () => {
    const result = await client.callTool({
      name: "find_definition",
      arguments: { name: "user", matchMode: "contains", caseSensitive: false, kinds: ["class", "interface", "type_alias"] },
    });
    assert.deepEqual(
      result.structuredContent.results.map((definition) => definition.name).sort(),
      ["CreateUserInput", "User", "UserService", "UserServiceOptions"],
    );
  });

  test("find_definition: pagination", async () => {
    const firstPage = await client.callTool({
      name: "find_definition",
      arguments: { name: "create", matchMode: "prefix", limit: 3 },
    });
    assert.equal(firstPage.structuredContent.count, 3);
    assert.equal(firstPage.structuredContent.hasMore, true);
    assert.equal(firstPage.structuredContent.nextOffset, 3);
    assert.match(textOf(firstPage), /offset=3/);

    const secondPage = await client.callTool({
      name: "find_definition",
      arguments: { name: "create", matchMode: "prefix", limit: 3, offset: 3 },
    });
    assert.equal(secondPage.structuredContent.count, 1);
    assert.equal(secondPage.structuredContent.hasMore, false);
    assert.equal(secondPage.structuredContent.nextOffset, undefined);
  });

  test("find_definition: errors and empty results", async () => {
    const notADirectory = await client.callTool({
      name: "find_definition",
      arguments: { name: "x", directory: repoFile("src", "index.mjs") },
    });
    assert.equal(notADirectory.isError, true);
    assert.match(textOf(notADirectory), /^Error \[NOT_A_DIRECTORY\]/);

    const badName = await client.callTool({ name: "find_definition", arguments: { name: "foo bar" } });
    assert.equal(badName.isError, true);

    const nothing = await client.callTool({ name: "find_definition", arguments: { name: "DoesNotExist" } });
    assert.equal(nothing.structuredContent.total, 0);
    assert.match(textOf(nothing), /No definitions found/);
  });
});

// ---------------------------------------------------------------------------
// Unrestricted server (no roots)
// ---------------------------------------------------------------------------

describe("unrestricted server", () => {
  let workspace;
  let client;

  before(async () => {
    workspace = await createWorkspace();
    client = await connectClient([]);
  });

  after(async () => {
    await client?.close();
    await rm(workspace.base, { recursive: true, force: true });
  });

  test("reads any absolute path", async () => {
    const result = await client.callTool({ name: "get_file_structure", arguments: { filePath: workspace.outsideFile } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.filePath, workspace.outsideFile);
  });

  test("find_definition requires a directory when no root is configured", async () => {
    const result = await client.callTool({ name: "find_definition", arguments: { name: "UserService" } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^Error \[MISSING_DIRECTORY\]/);

    const withDirectory = await client.callTool({
      name: "find_definition",
      arguments: { name: "UserService", directory: workspace.repo },
    });
    assert.equal(withDirectory.structuredContent.total, 1);
  });
});

// ---------------------------------------------------------------------------
// Raw stdio: malformed payloads must never kill the server or pollute stdout
// ---------------------------------------------------------------------------

describe("resilience to malformed payloads", () => {
  test("rejects garbage with JSON-RPC errors and keeps serving", async () => {
    const child = spawn(process.execPath, [serverEntry], { stdio: ["pipe", "pipe", "pipe"] });
    const messages = [];
    const nonJsonStdoutLines = [];
    let stdoutBuffer = "";
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
          nonJsonStdoutLines.push(line);
        }
      }
    });
    child.stderr.resume();

    const send = (payload) => child.stdin.write(typeof payload === "string" ? payload : `${JSON.stringify(payload)}\n`);
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const found = messages.find(predicate);
        if (found) {
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for: ${label}`);
    };

    try {
      send("this is not json\n");
      const parseError = await waitFor((m) => m.error?.code === -32700, "parse error");
      assert.equal(parseError.id, undefined);

      send('{"hello":"world"}\n');
      await waitFor((m) => m.error?.code === -32600 && m.id === undefined && /JSON-RPC/.test(m.error.message), "invalid request");

      send('{"jsonrpc":"2.0","id":7,"method":42}\n');
      await waitFor((m) => m.id === 7 && m.error?.code === -32600, "invalid request echoing id");

      // 11 MiB without a newline: over the frame limit. The SDK transport would close here.
      child.stdin.write(Buffer.alloc(11 * 1024 * 1024, 0x61));
      send("\n\n");
      await waitFor((m) => m.error?.code === -32600 && /exceeds/.test(m.error.message), "oversized frame");

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
      });
      const initialized = await waitFor((m) => m.id === 1, "initialize result");
      assert.equal(initialized.result.serverInfo.name, "ast-navigator-mcp-server");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });

      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_file_structure", arguments: { filePath: 123 } } });
      const invalidArguments = await waitFor((m) => m.id === 2, "tools/call with invalid arguments");
      assert.equal(invalidArguments.result.isError, true);

      send({ jsonrpc: "2.0", id: 3, method: "no/such/method" });
      const unknownMethod = await waitFor((m) => m.id === 3, "unknown method");
      assert.equal(unknownMethod.error.code, -32601);

      send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
      const toolList = await waitFor((m) => m.id === 4, "tools/list after garbage");
      assert.equal(toolList.result.tools.length, 3);

      assert.equal(child.exitCode, null, "server must still be running");
      assert.deepEqual(nonJsonStdoutLines, [], "stdout must carry JSON-RPC only");
    } finally {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.stdin.end(); // closing stdin ends the session gracefully
      const exitCode = await exited;
      assert.equal(exitCode, 0, "server should exit cleanly when stdin closes");
    }
  });
});
