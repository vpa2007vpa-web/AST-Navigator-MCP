/**
 * Regression tests for the allowed-roots sandbox.
 *
 * The contract: nothing outside the configured roots can be read, listed or
 * even *probed* - an out-of-root path yields PATH_OUTSIDE_ROOTS whether or not
 * it exists - while every legitimate spelling of an in-root path keeps working.
 *
 * Directory links are created as junctions: real symlinks on POSIX, and NTFS
 * junctions on Windows, which (unlike symlinks) need no special privilege.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { readSourceFile } from "../dist/parser/fileReader.js";
import { PathPolicy } from "../dist/tools/pathPolicy.js";
import { connectClient, firstLineOf, textOf } from "./helpers.mjs";

const isWindows = process.platform === "win32";
const BACKSLASH = "\\";

/**
 * base/
 * ├── repo/                 <- the only allowed root
 * │   ├── src/ok.ts
 * │   └── escape  -> base/secrets   (link inside the root pointing out)
 * ├── repo-evil/evil.ts     (sibling sharing the root's name as a prefix)
 * ├── secrets/leak.ts
 * └── alias       -> base/repo      (link outside the root pointing in)
 */
async function createSandboxWorkspace() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "ast-navigator-sandbox-")));
  const repo = path.join(base, "repo");
  const secrets = path.join(base, "secrets");
  const evil = path.join(base, "repo-evil");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(secrets, { recursive: true });
  await mkdir(evil, { recursive: true });
  await writeFile(path.join(repo, "src", "ok.ts"), "export class Inside {}\n");
  await writeFile(path.join(secrets, "leak.ts"), "export class Leaked {}\n");
  await writeFile(path.join(evil, "evil.ts"), "export class Evil {}\n");

  const links = { escape: path.join(repo, "escape"), alias: path.join(base, "alias") };
  let linksCreated = true;
  try {
    await symlink(secrets, links.escape, "junction");
    await symlink(repo, links.alias, "junction");
  } catch {
    linksCreated = false;
  }
  return { base, repo, secrets, evil, links, linksCreated };
}

const outsideRoots = { code: "PATH_OUTSIDE_ROOTS" };

// ---------------------------------------------------------------------------
// PathPolicy (unit)
// ---------------------------------------------------------------------------

describe("PathPolicy", () => {
  let workspace;
  let policy;

  before(async () => {
    workspace = await createSandboxWorkspace();
    policy = new PathPolicy([workspace.repo]);
  });

  after(async () => {
    await rm(workspace.base, { recursive: true, force: true });
  });

  test("resolves in-root paths to their canonical form", async () => {
    assert.equal(await policy.resolve("src/ok.ts"), path.join(workspace.repo, "src", "ok.ts"));
    assert.equal(await policy.resolve(workspace.repo), workspace.repo);
  });

  test("rejects relative and absolute traversal out of the root", async () => {
    await assert.rejects(policy.resolve("../secrets/leak.ts"), outsideRoots);
    await assert.rejects(policy.resolve("src/../../secrets/leak.ts"), outsideRoots);
    await assert.rejects(policy.resolve(".."), outsideRoots);
    await assert.rejects(policy.resolve(path.join(workspace.secrets, "leak.ts")), outsideRoots);
  });

  test("treats a sibling directory sharing the root's prefix as outside", async () => {
    await assert.rejects(policy.resolve(path.join(workspace.evil, "evil.ts")), outsideRoots);
    await assert.rejects(policy.resolve("../repo-evil/evil.ts"), outsideRoots);
  });

  test("gives the same answer for out-of-root paths whether or not they exist", async () => {
    // Before the fix, a missing path answered FILE_NOT_FOUND and an existing one
    // PATH_OUTSIDE_ROOTS: an existence oracle for the whole disk.
    await assert.rejects(policy.resolve(path.join(workspace.secrets, "leak.ts")), outsideRoots);
    await assert.rejects(policy.resolve(path.join(workspace.secrets, "missing.ts")), outsideRoots);
    await assert.rejects(policy.resolve(path.join(workspace.base, "no-such-dir", "x.ts")), outsideRoots);
  });

  test("keeps precise diagnostics for paths inside the root", async () => {
    await assert.rejects(policy.resolve("src/missing.ts"), { code: "FILE_NOT_FOUND" });
  });

  test("rejects unusable input itself, without relying on the tool schemas", async () => {
    await assert.rejects(async () => policy.resolve("src/ok.ts\0.txt"), { code: "INVALID_PATH" });
    await assert.rejects(async () => policy.resolve("   "), { code: "INVALID_PATH" });
  });

  test("a link inside the root cannot be used to leave it", async (t) => {
    if (!workspace.linksCreated) {
      t.skip("could not create directory links on this system");
      return;
    }
    await assert.rejects(policy.resolve(path.join(workspace.links.escape, "leak.ts")), outsideRoots);
    await assert.rejects(policy.resolve("escape/leak.ts"), outsideRoots);
  });

  test("a link inside the root does not reveal what exists beneath its target", async (t) => {
    if (!workspace.linksCreated) {
      t.skip("could not create directory links on this system");
      return;
    }
    // Before the fix, a missing file under the link answered FILE_NOT_FOUND while
    // an existing one answered PATH_OUTSIDE_ROOTS: the link became a probe.
    await assert.rejects(policy.resolve("escape/leak.ts"), outsideRoots); // exists out there
    await assert.rejects(policy.resolve("escape/missing.ts"), outsideRoots); // does not
    await assert.rejects(policy.resolve("escape/no-such-dir/x.ts"), outsideRoots); // nor does its parent
    // Missing paths whose existing ancestors are all inside keep the precise diagnostic.
    await assert.rejects(policy.resolve("src/no-such-dir/x.ts"), { code: "FILE_NOT_FOUND" });
  });

  test("a path reaching the root through an outside link is still allowed", async (t) => {
    if (!workspace.linksCreated) {
      t.skip("could not create directory links on this system");
      return;
    }
    // The /tmp -> /private/tmp situation on macOS: lexically outside, canonically inside.
    const viaAlias = path.join(workspace.links.alias, "src", "ok.ts");
    assert.equal(await policy.resolve(viaAlias), path.join(workspace.repo, "src", "ok.ts"));
  });

  test("an unrestricted policy resolves without touching the filesystem", async () => {
    const unrestricted = new PathPolicy([]);
    const missing = path.join(workspace.base, "no-such-dir", "x.ts");
    assert.equal(await unrestricted.resolve(missing), missing);
  });
});

// ---------------------------------------------------------------------------
// readSourceFile (unit)
// ---------------------------------------------------------------------------

describe("readSourceFile", () => {
  let directory;

  before(async () => {
    directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "ast-navigator-reader-")));
  });

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("strips a UTF-8 BOM and reports the bytes actually read", async () => {
    const file = path.join(directory, "bom.ts");
    await writeFile(file, "\uFEFFexport const a = 1;\n", "utf8");
    const source = await readSourceFile(file);
    assert.equal(source.content, "export const a = 1;\n");
    assert.equal(source.sizeBytes, Buffer.byteLength("\uFEFFexport const a = 1;\n"));
  });

  test("enforces the size limit", async () => {
    const file = path.join(directory, "big.ts");
    await writeFile(file, "x".repeat(1024));
    await assert.rejects(readSourceFile(file, { maxBytes: 100 }), { code: "FILE_TOO_LARGE" });
    assert.equal((await readSourceFile(file, { maxBytes: 1024 })).sizeBytes, 1024);
  });

  test("maps directories and missing files to typed errors", async () => {
    await assert.rejects(readSourceFile(directory), { code: "NOT_A_FILE" });
    await assert.rejects(readSourceFile(path.join(directory, "missing.ts")), { code: "FILE_NOT_FOUND" });
  });

  test("denySymlinks refuses a symlink at the final component", async (t) => {
    if (isWindows) {
      t.skip("O_NOFOLLOW does not exist on Windows; the option is documented as a no-op there");
      return;
    }
    const target = path.join(directory, "real.ts");
    const link = path.join(directory, "link.ts");
    await writeFile(target, "export const real = 1;\n");
    await symlink(target, link);

    assert.equal((await readSourceFile(link)).content, "export const real = 1;\n", "followed by default");
    await assert.rejects(readSourceFile(link, { denySymlinks: true }), { code: "READ_FAILED" });
    assert.equal((await readSourceFile(target, { denySymlinks: true })).content, "export const real = 1;\n");
  });
});

// ---------------------------------------------------------------------------
// Sandboxed server (end to end)
// ---------------------------------------------------------------------------

describe("sandboxed server: traversal barriers", () => {
  let workspace;
  let client;

  const outlineOf = (filePath) => client.callTool({ name: "get_file_structure", arguments: { filePath } });
  const searchIn = (directory, name = "Leaked") => client.callTool({ name: "find_definition", arguments: { name, directory } });

  before(async () => {
    workspace = await createSandboxWorkspace();
    client = await connectClient([workspace.repo]);
  });

  after(async () => {
    await client?.close();
    await rm(workspace.base, { recursive: true, force: true });
  });

  test("get_file_structure rejects every traversal spelling with PATH_OUTSIDE_ROOTS", async () => {
    const leak = path.join(workspace.secrets, "leak.ts");
    const attempts = [
      "../secrets/leak.ts",
      "../../../etc/passwd.ts",
      "src/../../secrets/leak.ts",
      "src/./..//..//secrets//leak.ts",
      "../repo-evil/evil.ts",
      leak,
      leak.split(BACKSLASH).join("/"),
      path.join(workspace.evil, "evil.ts"),
    ];
    if (isWindows) {
      attempts.push(`..${BACKSLASH}secrets${BACKSLASH}leak.ts`, `src${BACKSLASH}..${BACKSLASH}..${BACKSLASH}secrets${BACKSLASH}leak.ts`);
    }
    for (const attempt of attempts) {
      const result = await outlineOf(attempt);
      assert.equal(result.isError, true, attempt);
      assert.match(firstLineOf(result), /^Error \[PATH_OUTSIDE_ROOTS\]/, attempt);
    }
  });

  test("out-of-root paths are indistinguishable whether or not they exist", async () => {
    const probes = [
      path.join(workspace.secrets, "leak.ts"), // exists
      path.join(workspace.secrets, "missing.ts"), // does not exist
      path.join(workspace.base, "no-such-dir", "x.ts"), // parent does not exist either
    ];
    const codes = [];
    for (const probe of probes) {
      codes.push(firstLineOf(await outlineOf(probe)).match(/^Error \[(\w+)\]/)?.[1]);
    }
    assert.deepEqual(codes, ["PATH_OUTSIDE_ROOTS", "PATH_OUTSIDE_ROOTS", "PATH_OUTSIDE_ROOTS"]);
  });

  test("malformed paths are refused by input validation before any filesystem access", async () => {
    const inRoot = path.join(workspace.repo, "src", "ok.ts");
    const attempts = [
      [`${BACKSLASH}${BACKSLASH}?${BACKSLASH}${inRoot}`, /device-namespace/],
      [`${BACKSLASH}${BACKSLASH}.${BACKSLASH}${inRoot}`, /device-namespace/],
      ["//?/C:/repo/src/ok.ts", /device-namespace/],
      [`${inRoot}\u0000.txt`, /control characters/],
      [`${path.join(workspace.repo, "src")}\nok.ts`, /control characters/],
      [`src/ok\u0007.ts`, /control characters/],
      [`src/ok\u007f.ts`, /control characters/],
    ];
    for (const [attempt, reason] of attempts) {
      const result = await outlineOf(attempt);
      assert.equal(result.isError, true, JSON.stringify(attempt));
      assert.match(textOf(result), reason, JSON.stringify(attempt));
    }
  });

  test("find_definition refuses directories outside the root", async () => {
    for (const directory of ["..", "src/../..", workspace.secrets, workspace.base, workspace.evil]) {
      const result = await searchIn(directory);
      assert.equal(result.isError, true, directory);
      assert.match(firstLineOf(result), /^Error \[PATH_OUTSIDE_ROOTS\]/, directory);
    }
  });

  test("a link inside the root cannot be used to read or search outside it", async (t) => {
    if (!workspace.linksCreated) {
      t.skip("could not create directory links on this system");
      return;
    }
    const viaLink = await outlineOf(path.join(workspace.links.escape, "leak.ts"));
    assert.match(firstLineOf(viaLink), /^Error \[PATH_OUTSIDE_ROOTS\]/);

    const linkAsDirectory = await searchIn(workspace.links.escape);
    assert.match(firstLineOf(linkAsDirectory), /^Error \[PATH_OUTSIDE_ROOTS\]/);

    // A recursive scan of the root must not descend through the link either.
    const rootScan = await client.callTool({ name: "find_definition", arguments: { name: "Leaked" } });
    assert.equal(rootScan.structuredContent.total, 0);
    const control = await client.callTool({ name: "find_definition", arguments: { name: "Inside" } });
    assert.equal(control.structuredContent.total, 1);
  });

  test("a link inside the root cannot be used to probe what exists beneath its target", async (t) => {
    if (!workspace.linksCreated) {
      t.skip("could not create directory links on this system");
      return;
    }
    const codes = [];
    for (const probe of ["escape/leak.ts", "escape/missing.ts", "escape/no-such-dir/x.ts"]) {
      codes.push(firstLineOf(await outlineOf(probe)).match(/^Error \[(\w+)\]/)?.[1]);
    }
    assert.deepEqual(codes, ["PATH_OUTSIDE_ROOTS", "PATH_OUTSIDE_ROOTS", "PATH_OUTSIDE_ROOTS"]);
  });

  test("a path reaching the root through an outside link is still served, canonically", async (t) => {
    if (!workspace.linksCreated) {
      t.skip("could not create directory links on this system");
      return;
    }
    const result = await outlineOf(path.join(workspace.links.alias, "src", "ok.ts"));
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.filePath, path.join(workspace.repo, "src", "ok.ts"));
  });

  test("legitimate spellings of in-root paths keep working", async () => {
    const canonical = path.join(workspace.repo, "src", "ok.ts");
    const spellings = ["src/ok.ts", "./src/ok.ts", "src/./../src/ok.ts", canonical];
    if (isWindows) {
      spellings.push(`src${BACKSLASH}..${BACKSLASH}src/ok.ts`, canonical.split(BACKSLASH).join("/"));
    }
    for (const spelling of spellings) {
      const result = await outlineOf(spelling);
      assert.equal(result.isError, undefined, `${spelling}: ${firstLineOf(result)}`);
      assert.equal(result.structuredContent.filePath, canonical, spelling);
    }
  });
});
