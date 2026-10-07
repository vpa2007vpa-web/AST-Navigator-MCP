/**
 * Tests for analyze_dependencies: reference extraction from the syntax tree,
 * specifier resolution through the sandbox, and the tool end to end.
 *
 * The security contract mirrors the other tools: the analysed file must be
 * inside the roots, and a dependency that leads outside them is reported as
 * `outside_roots` without revealing where it points or whether it exists.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { MAX_DEPENDENCY_SPECIFIERS, MAX_SPECIFIER_LENGTH } from "../dist/constants.js";
import { listModuleReferences } from "../dist/parser/dependencies.js";
import { parseSource } from "../dist/parser/treeSitterParser.js";
import { isLocalSpecifier, resolveLocalSpecifier } from "../dist/tools/dependencyResolver.js";
import { PathPolicy } from "../dist/tools/pathPolicy.js";
import { connectClient, firstLineOf, projectRoot, textOf } from "./helpers.mjs";

const isWindows = process.platform === "win32";

const scan = (source, language = "typescript") => listModuleReferences(parseSource(source, language, "test-input"));
const summarise = (references) => references.map(({ specifier, kind, typeOnly, line }) => [specifier, kind, typeOnly, line]);

/**
 * base/
 * ├── repo/src/            <- the only allowed root is base/repo
 * │   ├── main.ts          (the file analysed end to end)
 * │   ├── util.ts  types.d.ts  comp.tsx  legacy.js  data.json  icon.svg
 * │   ├── compiled.ts + compiled.js   (TS source next to its build output)
 * │   ├── lib/index.ts
 * │   └── escape -> base/secrets      (link inside the root pointing out)
 * └── secrets/leak.ts
 */
const MAIN_SOURCE = [
  'import { helper } from "./util.js";', // 1
  'import type { Shape } from "./types";', // 2
  'import type { Helper } from "./util";', // 3  same file as line 1
  'export * from "./lib";', // 4
  'import config from "./data.json";', // 5
  'import React from "react";', // 6
  'import { readFile } from "node:fs";', // 7
  'import "./missing-polyfill";', // 8
  'import { leak } from "../../secrets/leak";', // 9
  'import { more } from "./escape/leak";', // 10
  "export function lazy() {", // 11
  '  const legacy = require("./legacy.js");', // 12
  "  return import(`./plugins/${legacy.name}`);", // 13
  "}", // 14
].join("\n");

async function createDependencyWorkspace() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "ast-navigator-deps-")));
  const repo = path.join(base, "repo");
  const src = path.join(repo, "src");
  const secrets = path.join(base, "secrets");
  await mkdir(path.join(src, "lib"), { recursive: true });
  await mkdir(secrets, { recursive: true });

  const files = {
    "main.ts": MAIN_SOURCE,
    "util.ts": "export const helper = 1;\nexport interface Helper {}\n",
    "types.d.ts": "export interface Shape {}\n",
    "comp.tsx": "export const Comp = () => null;\n",
    "legacy.js": "module.exports = { name: 'legacy' };\n",
    "compiled.ts": "export const compiled = 1;\n",
    "compiled.js": "exports.compiled = 1;\n",
    "data.json": "{}\n",
    "icon.svg": "<svg/>\n",
    [path.join("lib", "index.ts")]: "export const lib = 1;\n",
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(src, name), content);
  }
  await writeFile(path.join(secrets, "leak.ts"), "export const leak = 1;\n");

  let linksCreated = true;
  try {
    await symlink(secrets, path.join(src, "escape"), "junction");
  } catch {
    linksCreated = false;
  }
  return { base, repo, src, secrets, linksCreated, main: path.join(src, "main.ts") };
}

// ---------------------------------------------------------------------------
// Reference extraction (Tree-sitter)
// ---------------------------------------------------------------------------

describe("module reference extraction", () => {
  test("finds every reference form, with kind, type-only flag and line", () => {
    const result = scan(
      [
        'import Default from "./default";',
        'import type { T } from "./types";',
        'import "./side-effect";',
        'export * from "./star";',
        'export type { X } from "./type-reexport";',
        'export { y } from "./named-reexport";',
        'import legacy = require("./legacy");',
        "export const local = 1;",
        "function load() {",
        '  const nested = require("./nested");',
        '  return import("./lazy");',
        "}",
        "const tpl = require(`./template`);",
        'import { readFile } from "node:fs";',
      ].join("\n"),
    );
    assert.deepEqual(summarise(result.references), [
      ["./default", "import", false, 1],
      ["./types", "import", true, 2],
      ["./side-effect", "import", false, 3],
      ["./star", "re-export", false, 4],
      ["./type-reexport", "re-export", true, 5],
      ["./named-reexport", "re-export", false, 6],
      ["./legacy", "require", false, 7],
      ["./nested", "require", false, 10],
      ["./lazy", "dynamic-import", false, 11],
      ["./template", "require", false, 13],
      ["node:fs", "import", false, 14],
    ]);
    assert.equal(result.nonLiteralCount, 0);
    assert.equal(result.hasSyntaxErrors, false);
  });

  test("counts computed require()/import() targets and ignores other calls", () => {
    const result = scan(
      [
        "const a = require(name);",
        "const b = import(`./plugins/${name}`);",
        "const c = require();",
        'const d = require.resolve("./resolved-only");',
        'const e = loader.require("./method-call");',
        'const f = requireLike("./other-function");',
      ].join("\n"),
    );
    assert.deepEqual(result.references, []);
    assert.equal(result.nonLiteralCount, 3);
  });

  test("handles CommonJS and dynamic import in plain JavaScript", () => {
    const result = scan(
      ['const { a } = require("./a.js");', 'module.exports = { b: require("./b.cjs") };', 'import("./c.mjs").then(() => {});'].join("\n"),
      "javascript",
    );
    assert.deepEqual(summarise(result.references), [
      ["./a.js", "require", false, 1],
      ["./b.cjs", "require", false, 2],
      ["./c.mjs", "dynamic-import", false, 3],
    ]);
  });

  test("still reports references in a file with syntax errors", () => {
    const result = scan(['import { ok } from "./ok";', "function broken( {", 'const x = require("./after-error");'].join("\n"));
    assert.equal(result.hasSyntaxErrors, true);
    assert.ok(result.references.some((reference) => reference.specifier === "./ok"));
  });
});

// ---------------------------------------------------------------------------
// Specifier classification and resolution (unit)
// ---------------------------------------------------------------------------

describe("dependency resolution", () => {
  let workspace;
  let policy;
  const resolveFrom = (specifier, language = "typescript", importer = workspace.main) =>
    resolveLocalSpecifier(specifier, importer, language, policy);

  before(async () => {
    workspace = await createDependencyWorkspace();
    policy = new PathPolicy([workspace.repo]);
  });

  after(async () => {
    await rm(workspace.base, { recursive: true, force: true });
  });

  test("classifies local and external specifiers", () => {
    const local = ["./a", "../a", ".", "..", "./", "/abs/a.js", "file:///abs/a.js"];
    const external = ["react", "@scope/pkg", "lodash/fp", "node:fs", "fs", "#internal", "@/alias", "~/alias", ".hidden", "data:text/javascript,1", "https://cdn.example/a.js"];
    if (isWindows) {
      local.push(".\\a", "..\\a", "C:\\abs\\a.js", "C:/abs/a.js");
    }
    for (const specifier of local) {
      assert.equal(isLocalSpecifier(specifier), true, specifier);
    }
    for (const specifier of external) {
      assert.equal(isLocalSpecifier(specifier), false, specifier);
    }
  });

  test("resolves the forms TypeScript and Node.js accept", async () => {
    const src = (...segments) => path.join(workspace.src, ...segments);
    const cases = [
      ["./util", "typescript", src("util.ts")],
      ["./util.js", "typescript", src("util.ts")], // NodeNext: .js names the .ts source
      ["./comp.jsx", "tsx", src("comp.tsx")],
      ["./compiled.js", "typescript", src("compiled.ts")], // a TS importer prefers the source...
      ["./compiled.js", "javascript", src("compiled.js")], // ...a JS importer what Node.js loads
      ["./legacy.js", "typescript", src("legacy.js")], // no TS source: the file itself
      ["./lib", "typescript", src("lib", "index.ts")],
      ["./lib/", "typescript", src("lib", "index.ts")],
      ["./types", "typescript", src("types.d.ts")],
      ["./data.json", "typescript", src("data.json")],
      ["./icon.svg?raw", "typescript", src("icon.svg")], // bundler query suffix
      [pathToFileURL(src("util.ts")).href, "typescript", src("util.ts")],
      [src("util.ts"), "typescript", src("util.ts")], // absolute path
    ];
    for (const [specifier, language, expected] of cases) {
      assert.deepEqual(await resolveFrom(specifier, language), { status: "resolved", path: expected }, `${specifier} (${language})`);
    }
  });

  test("reports what it cannot resolve without probing outside the sandbox", async () => {
    const unresolved = (reason) => ({ status: "unresolved", reason });
    assert.deepEqual(await resolveFrom("./missing"), unresolved("not_found"));
    // Outside the roots: the same answer whether the target exists or not.
    assert.deepEqual(await resolveFrom("../../secrets/leak"), unresolved("outside_roots"));
    assert.deepEqual(await resolveFrom("../../secrets/missing"), unresolved("outside_roots"));
    assert.deepEqual(await resolveFrom("../../no-such-dir/x"), unresolved("outside_roots"));
    assert.deepEqual(await resolveFrom(`./${"a".repeat(MAX_SPECIFIER_LENGTH)}`), unresolved("invalid"));
    assert.deepEqual(await resolveFrom("./a\u0000b"), unresolved("invalid"));
  });

  test("a link inside the root cannot be followed out, nor used as a probe", async (t) => {
    if (!workspace.linksCreated) {
      t.skip("could not create directory links on this system");
      return;
    }
    assert.deepEqual(await resolveFrom("./escape/leak"), { status: "unresolved", reason: "outside_roots" });
    assert.deepEqual(await resolveFrom("./escape/missing"), { status: "unresolved", reason: "outside_roots" });
  });

  test("an unrestricted policy resolves anywhere the process can read", async () => {
    const unrestricted = new PathPolicy([]);
    assert.deepEqual(await resolveLocalSpecifier("../../secrets/leak", workspace.main, "typescript", unrestricted), {
      status: "resolved",
      path: path.join(workspace.secrets, "leak.ts"),
    });
  });
});

// ---------------------------------------------------------------------------
// analyze_dependencies (end to end)
// ---------------------------------------------------------------------------

describe("analyze_dependencies tool", () => {
  let workspace;
  let client;
  const analyze = (args) => client.callTool({ name: "analyze_dependencies", arguments: args });

  before(async () => {
    workspace = await createDependencyWorkspace();
    client = await connectClient([workspace.repo]);
  });

  after(async () => {
    await client?.close();
    await rm(workspace.base, { recursive: true, force: true });
  });

  test("is advertised as a read-only tool with strict input and an output schema", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "analyze_dependencies");
    assert.ok(tool);
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.required, ["filePath"]);
    assert.ok(tool.outputSchema);
  });

  test("maps a file to its internal dependencies and ignores packages", async () => {
    const result = await analyze({ filePath: workspace.main });
    assert.equal(result.isError, undefined);
    const src = (...segments) => path.join(workspace.src, ...segments);

    assert.deepEqual(result.structuredContent, {
      filePath: workspace.main,
      language: "typescript",
      hasSyntaxErrors: false,
      dependencies: [
        { path: src("util.ts"), specifiers: ["./util.js", "./util"], kinds: ["import"], typeOnly: false, lines: [1, 3] },
        { path: src("types.d.ts"), specifiers: ["./types"], kinds: ["import"], typeOnly: true, lines: [2] },
        { path: src("lib", "index.ts"), specifiers: ["./lib"], kinds: ["re-export"], typeOnly: false, lines: [4] },
        { path: src("data.json"), specifiers: ["./data.json"], kinds: ["import"], typeOnly: false, lines: [5] },
        { path: src("legacy.js"), specifiers: ["./legacy.js"], kinds: ["require"], typeOnly: false, lines: [12] },
      ],
      unresolved: [
        { specifier: "./missing-polyfill", reason: "not_found", kinds: ["import"], lines: [8] },
        { specifier: "../../secrets/leak", reason: "outside_roots", kinds: ["import"], lines: [9] },
        {
          specifier: "./escape/leak",
          reason: workspace.linksCreated ? "outside_roots" : "not_found",
          kinds: ["import"],
          lines: [10],
        },
      ],
      externalCount: 2, // react, node:fs
      nonLiteralCount: 1, // import(`./plugins/${...}`)
      truncated: false,
    });
  });

  test("never reveals where an out-of-root dependency points", async () => {
    for (const responseFormat of ["json", "markdown"]) {
      const text = textOf(await analyze({ filePath: workspace.main, responseFormat }));
      assert.ok(!text.includes(workspace.secrets), `${responseFormat} output leaked ${workspace.secrets}`);
      assert.ok(!text.includes(path.join(workspace.secrets, "leak.ts")), `${responseFormat} output leaked the target file`);
    }
  });

  test("includeTypeOnly: false keeps runtime dependencies only", async () => {
    const result = await analyze({ filePath: workspace.main, includeTypeOnly: false });
    const util = result.structuredContent.dependencies.find((dependency) => dependency.path.endsWith("util.ts"));
    assert.deepEqual(util, {
      path: path.join(workspace.src, "util.ts"),
      specifiers: ["./util.js"],
      kinds: ["import"],
      typeOnly: false,
      lines: [1],
    });
    assert.ok(!result.structuredContent.dependencies.some((dependency) => dependency.path.endsWith("types.d.ts")));
  });

  test("markdown output lists internal and unresolved dependencies", async () => {
    const text = textOf(await analyze({ filePath: "src/main.ts" }));
    assert.match(text, /^# Dependencies of .*main\.ts$/m);
    assert.match(text, /typescript \| 5 internal dependencies \| 3 unresolved \| 2 external specifiers ignored/);
    assert.match(text, /## Internal\n- .*util\.ts\n {2}"\.\/util\.js", "\.\/util" \[import\] L1, L3/);
    assert.match(text, /"\.\/types" \[import, type-only\] L2/);
    assert.match(text, /## Unresolved\n- "\.\/missing-polyfill": not_found \[import\] L8/);
    assert.match(text, /"\.\.\/\.\.\/secrets\/leak": outside_roots/);
    assert.match(text, /1 require\(\)\/import\(\) call with a computed argument could not be followed/);
  });

  test("the analysed file itself goes through the sandbox", async () => {
    const outside = [path.join(workspace.secrets, "leak.ts"), "../secrets/leak.ts", "../../../etc/passwd.ts"];
    if (workspace.linksCreated) {
      outside.push("src/escape/leak.ts", "src/escape/missing.ts");
    }
    for (const filePath of outside) {
      assert.match(firstLineOf(await analyze({ filePath })), /^Error \[PATH_OUTSIDE_ROOTS\]/, filePath);
    }
    assert.match(firstLineOf(await analyze({ filePath: "src/nope.ts" })), /^Error \[FILE_NOT_FOUND\]/);

    const invalid = await analyze({ filePath: "src/data.json" });
    assert.equal(invalid.isError, true);
    assert.match(textOf(invalid), /Unsupported file extension/);
    const control = await analyze({ filePath: "src/main\u0007.ts" });
    assert.equal(control.isError, true);
    assert.match(textOf(control), /control characters/);
    const extra = await analyze({ filePath: "src/main.ts", unexpected: true });
    assert.equal(extra.isError, true);
  });

  test("resolves a bounded number of distinct specifiers per call", async () => {
    const imports = Array.from({ length: MAX_DEPENDENCY_SPECIFIERS + 1 }, (_, index) => `import "./generated-${index}.js";`);
    await writeFile(path.join(workspace.src, "many.ts"), `${imports.join("\n")}\n`);

    const output = (await analyze({ filePath: "src/many.ts", responseFormat: "json" })).structuredContent;
    assert.equal(output.truncated, true);
    assert.equal(output.unresolved.length, MAX_DEPENDENCY_SPECIFIERS);
    assert.ok(output.unresolved.every((dependency) => dependency.reason === "not_found"));
  });
});

// ---------------------------------------------------------------------------
// Bundled fixture repository
// ---------------------------------------------------------------------------

describe("analyze_dependencies on the fixture repository", () => {
  const fixtureRepo = path.join(projectRoot, "test", "fixtures", "sample-repo");
  let client;

  before(async () => {
    client = await connectClient([fixtureRepo]);
  });

  after(async () => {
    await client?.close();
  });

  test("a TypeScript service: type-only and runtime imports, built-ins ignored", async () => {
    const result = await client.callTool({ name: "analyze_dependencies", arguments: { filePath: "src/services/UserService.ts" } });
    const output = result.structuredContent;
    const canonicalRepo = await realpath(fixtureRepo);
    assert.deepEqual(
      output.dependencies.map((dependency) => [path.relative(canonicalRepo, dependency.path), dependency.typeOnly]),
      [
        [path.join("src", "models", "user.ts"), true],
        [path.join("src", "db", "Repository.ts"), false],
      ],
    );
    assert.equal(output.externalCount, 1); // node:crypto
    assert.deepEqual(output.unresolved, []);
  });

  test("a JavaScript barrel: .js specifiers reach the TypeScript sources, missing files are reported", async () => {
    const result = await client.callTool({ name: "analyze_dependencies", arguments: { filePath: "src/index.mjs" } });
    const output = result.structuredContent;
    const canonicalRepo = await realpath(fixtureRepo);
    assert.equal(output.language, "javascript");
    assert.deepEqual(
      output.dependencies.map((dependency) => [path.relative(canonicalRepo, dependency.path), dependency.kinds]),
      [
        [path.join("src", "services", "UserService.ts"), ["re-export"]],
        [path.join("src", "models", "user.ts"), ["re-export"]],
      ],
    );
    assert.deepEqual(output.unresolved, [{ specifier: "./polyfills.js", reason: "not_found", kinds: ["import"], lines: [3] }]);
  });
});
