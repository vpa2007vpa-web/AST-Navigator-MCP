/**
 * Maps module specifiers found in a source file to the local files they load.
 *
 * Resolution follows what TypeScript and Node.js do for local specifiers:
 * the exact file, the TypeScript source behind a `.js` specifier (NodeNext
 * style), extension probing and directory `index` files. Every candidate is
 * checked through PathPolicy - the same sandbox every tool uses - before it is
 * even stat-ed, and the first candidate that falls outside the roots stops the
 * probing for that specifier. The result therefore never says which files
 * exist beyond the sandbox, nor where an escaping link points: only that the
 * specifier leads outside.
 *
 * Not resolved, and reported as external instead: bare package names,
 * `node:` built-ins, tsconfig `paths` aliases and package.json `#imports`.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { MAX_SPECIFIER_LENGTH } from "../constants.js";
import { AstNavigatorError, ErrorCode } from "../errors.js";
import type { LanguageId } from "../parser/index.js";
import type { PathPolicy } from "./pathPolicy.js";
import type { UnresolvedReason } from "./schemas.js";

export type Resolution =
  | { readonly status: "resolved"; readonly path: string }
  | { readonly status: "unresolved"; readonly reason: UnresolvedReason };

const RELATIVE_SPECIFIER = /^\.\.?(?:\/|$)/u;
/** `require(".\\x")` works on Windows; ES modules only ever use "/". */
const WINDOWS_RELATIVE_SPECIFIER = /^\.\.?\\/u;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/u;
const isWindows = process.platform === "win32";

/** True for specifiers that name a file on disk rather than a package or built-in. */
export function isLocalSpecifier(specifier: string): boolean {
  return (
    RELATIVE_SPECIFIER.test(specifier) ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:") ||
    (isWindows && (WINDOWS_RELATIVE_SPECIFIER.test(specifier) || WINDOWS_DRIVE_PATH.test(specifier)))
  );
}

/** TypeScript sources that a `.js`-family specifier can stand for. */
const TYPESCRIPT_SOURCES: ReadonlyMap<string, readonly string[]> = new Map([
  [".js", [".ts", ".tsx", ".d.ts"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts", ".d.mts"]],
  [".cjs", [".cts", ".d.cts"]],
]);

/** Extensions after which no further extension is appended. */
const RESOLVED_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]);

const TYPESCRIPT_FIRST = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const JAVASCRIPT_FIRST = [".js", ".jsx", ".mjs", ".cjs", ".json", ".ts", ".tsx", ".d.ts", ".mts", ".cts"];

/**
 * Files a specifier may refer to, most likely first. A TypeScript importer
 * prefers the `.ts` source over a compiled `.js` sibling; a JavaScript importer
 * prefers what Node.js would actually load.
 */
function candidatePaths(base: string, importer: LanguageId): string[] {
  const typescriptImporter = importer !== "javascript";
  const extension = path.extname(base).toLowerCase();
  const typescriptSources = TYPESCRIPT_SOURCES.get(extension);

  if (typescriptSources !== undefined) {
    const stem = base.slice(0, -extension.length);
    const sources = typescriptSources.map((sourceExtension) => `${stem}${sourceExtension}`);
    return typescriptImporter ? [...sources, base] : [base, ...sources];
  }

  const candidates = [base];
  if (!RESOLVED_EXTENSIONS.has(extension)) {
    const order = typescriptImporter ? TYPESCRIPT_FIRST : JAVASCRIPT_FIRST;
    candidates.push(...order.map((candidateExtension) => `${base}${candidateExtension}`));
    candidates.push(...order.map((candidateExtension) => path.join(base, `index${candidateExtension}`)));
  }
  return candidates;
}

/** Absolute path named by a local specifier, or undefined when it is not a usable path. */
function specifierToPath(specifier: string, importerPath: string): string | undefined {
  if (specifier.length > MAX_SPECIFIER_LENGTH || specifier.includes("\0")) {
    return undefined;
  }
  // Bundler query suffixes (`./icon.svg?raw`) are not part of the file name.
  const withoutQuery = specifier.split("?", 1)[0] ?? "";
  if (withoutQuery.startsWith("file:")) {
    try {
      return fileURLToPath(withoutQuery);
    } catch {
      return undefined;
    }
  }
  return path.resolve(path.dirname(importerPath), withoutQuery);
}

type Probe =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "missing" }
  | { readonly kind: "outside" }
  | { readonly kind: "invalid" };

async function probe(candidate: string, policy: PathPolicy): Promise<Probe> {
  let resolved: string;
  try {
    // The sandbox decides first: nothing outside the roots is ever stat-ed here.
    resolved = await policy.resolve(candidate);
  } catch (error) {
    if (error instanceof AstNavigatorError && error.code === ErrorCode.PATH_OUTSIDE_ROOTS) {
      return { kind: "outside" };
    }
    if (error instanceof AstNavigatorError && error.code === ErrorCode.INVALID_PATH) {
      return { kind: "invalid" };
    }
    return { kind: "missing" };
  }
  try {
    return (await stat(resolved)).isFile() ? { kind: "file", path: resolved } : { kind: "missing" };
  } catch {
    return { kind: "missing" };
  }
}

/**
 * Resolves one local specifier written in `importerPath` (already validated by
 * PathPolicy) to the file it loads.
 */
export async function resolveLocalSpecifier(
  specifier: string,
  importerPath: string,
  importerLanguage: LanguageId,
  policy: PathPolicy,
): Promise<Resolution> {
  const base = specifierToPath(specifier, importerPath);
  if (base === undefined) {
    return { status: "unresolved", reason: "invalid" };
  }

  for (const candidate of candidatePaths(base, importerLanguage)) {
    const outcome = await probe(candidate, policy);
    switch (outcome.kind) {
      case "file":
        return { status: "resolved", path: outcome.path };
      case "outside":
        // Stop: probing further candidates would only map what lies out there.
        return { status: "unresolved", reason: "outside_roots" };
      case "invalid":
        return { status: "unresolved", reason: "invalid" };
      case "missing":
        break;
    }
  }
  return { status: "unresolved", reason: "not_found" };
}
