import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { MAX_DEPENDENCY_SPECIFIERS, MAX_FILE_SIZE_BYTES } from "../constants.js";
import {
  extract_module_references,
  MODULE_REFERENCE_KINDS,
  type ModuleReference,
  type ModuleReferenceKind,
  SUPPORTED_EXTENSIONS,
} from "../parser/index.js";
import type { ToolContext } from "./context.js";
import { isLocalSpecifier, resolveLocalSpecifier } from "./dependencyResolver.js";
import { formatDependenciesMarkdown } from "./formatters.js";
import { errorResult, successResult } from "./responses.js";
import {
  AnalyzeDependenciesInputSchema,
  AnalyzeDependenciesOutputSchema,
  type AnalyzeDependenciesInput,
  type AnalyzeDependenciesOutput,
  type InternalDependency,
  type UnresolvedDependency,
} from "./schemas.js";

export const ANALYZE_DEPENDENCIES_TOOL = "analyze_dependencies";

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Kinds in their canonical order, so output does not depend on reference order. */
function orderedKinds(references: readonly ModuleReference[]): ModuleReferenceKind[] {
  const present = new Set(references.map((reference) => reference.kind));
  return MODULE_REFERENCE_KINDS.filter((kind) => present.has(kind));
}

function orderedLines(references: readonly ModuleReference[]): number[] {
  return [...new Set(references.map((reference) => reference.line))].sort((left, right) => left - right);
}

/** Several specifiers (`./a`, `./a.js`) can name the same file: one entry per file. */
interface DependencyAccumulator {
  readonly specifiers: string[];
  readonly references: ModuleReference[];
}

export async function analyzeDependencies(input: AnalyzeDependenciesInput, context: ToolContext): Promise<AnalyzeDependenciesOutput> {
  const filePath = await context.pathPolicy.resolve(input.filePath);
  // Same reasoning as get_file_structure: a restricted path is canonical, so a
  // symlink at its last component can only be a swap made after validation.
  const scan = await extract_module_references(filePath, { denySymlinks: context.pathPolicy.isRestricted });

  const references = input.includeTypeOnly ? scan.references : scan.references.filter((reference) => !reference.typeOnly);

  // Group by specifier, in order of first appearance; count packages once each.
  const localSpecifiers = new Map<string, ModuleReference[]>();
  const externalSpecifiers = new Set<string>();
  for (const reference of references) {
    if (!isLocalSpecifier(reference.specifier)) {
      externalSpecifiers.add(reference.specifier);
      continue;
    }
    const group = localSpecifiers.get(reference.specifier);
    if (group === undefined) {
      localSpecifiers.set(reference.specifier, [reference]);
    } else {
      group.push(reference);
    }
  }

  const byPath = new Map<string, DependencyAccumulator>();
  const unresolved: UnresolvedDependency[] = [];
  const toResolve = [...localSpecifiers].slice(0, MAX_DEPENDENCY_SPECIFIERS);

  for (const [specifier, group] of toResolve) {
    const resolution = await resolveLocalSpecifier(specifier, scan.filePath, scan.language, context.pathPolicy);
    if (resolution.status === "unresolved") {
      unresolved.push({ specifier, reason: resolution.reason, kinds: orderedKinds(group), lines: orderedLines(group) });
      continue;
    }
    const accumulator = byPath.get(resolution.path);
    if (accumulator === undefined) {
      byPath.set(resolution.path, { specifiers: [specifier], references: [...group] });
    } else {
      accumulator.specifiers.push(specifier);
      accumulator.references.push(...group);
    }
  }

  const dependencies: InternalDependency[] = [...byPath].map(([dependencyPath, accumulator]) => ({
    path: dependencyPath,
    specifiers: accumulator.specifiers,
    kinds: orderedKinds(accumulator.references),
    typeOnly: accumulator.references.every((reference) => reference.typeOnly),
    lines: orderedLines(accumulator.references),
  }));

  return {
    filePath: scan.filePath,
    language: scan.language,
    hasSyntaxErrors: scan.hasSyntaxErrors,
    dependencies,
    unresolved,
    externalCount: externalSpecifiers.size,
    nonLiteralCount: scan.nonLiteralCount,
    truncated: localSpecifiers.size > MAX_DEPENDENCY_SPECIFIERS,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function describeTool(context: ToolContext): string {
  const sandbox = context.pathPolicy.isRestricted
    ? `\n\nThis server can only read inside: ${context.pathPolicy.allowedRoots.join(", ")}.`
    : "";
  return `List the local files one JavaScript/TypeScript file depends on, from its Tree-sitter syntax tree: ES imports (including side-effect and \`import type\`), re-exports (\`export ... from\`), \`require()\` (also TypeScript \`import x = require()\`) and dynamic \`import()\`, anywhere in the file. Packages (node_modules), \`node:\` built-ins and path aliases are counted but not listed.

Use it to follow a module's dependency graph one file at a time, or to see what a file pulls in before changing it. It lists what a file imports, not which files import it.

Resolution mirrors TypeScript/Node.js for local specifiers: exact file, the .ts source behind a .js specifier, extension probing (.ts .tsx .d.ts .mts .cts .js .jsx .mjs .cjs .json) and directory index files. tsconfig 'paths' and package.json 'exports' are not read.

Args:
  - filePath (string): file to analyse (${SUPPORTED_EXTENSIONS.join(" ")}). Absolute path recommended.
  - includeTypeOnly (boolean): include type-only references, erased at compile time (default true).
  - responseFormat ('markdown' | 'json'): 'markdown' (default) is a compact list; 'json' returns the full object.

Returns (structuredContent):
  { filePath, language, hasSyntaxErrors,
    dependencies[{ path, specifiers[], kinds[import|re-export|require|dynamic-import], typeOnly, lines[] }],
    unresolved[{ specifier, reason: not_found|outside_roots|invalid, kinds[], lines[] }],
    externalCount, nonLiteralCount, truncated }
  Dependencies are listed in order of first reference; several specifiers naming the same file are merged.

Examples:
  - "What does src/server.ts import from this repo?" -> { filePath: "/repo/src/server.ts" }
  - Runtime dependencies only -> add includeTypeOnly: false

Errors (isError=true, text starts with 'Error [CODE]'): FILE_NOT_FOUND, PERMISSION_DENIED, NOT_A_FILE,
FILE_TOO_LARGE (> ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MiB), PATH_OUTSIDE_ROOTS, INVALID_PATH. A dependency pointing outside the allowed roots is
reported as unresolved with reason 'outside_roots'; its target is never revealed.${sandbox}`;
}

export function registerAnalyzeDependenciesTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    ANALYZE_DEPENDENCIES_TOOL,
    {
      title: "Analyze Dependencies (local imports)",
      description: describeTool(context),
      inputSchema: AnalyzeDependenciesInputSchema,
      outputSchema: AnalyzeDependenciesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: AnalyzeDependenciesInput): Promise<CallToolResult> => {
      try {
        const output = await analyzeDependencies(input, context);
        const text = input.responseFormat === "json" ? JSON.stringify(output, null, 2) : formatDependenciesMarkdown(output);
        return successResult(text, output);
      } catch (error) {
        return errorResult(error, context.logger);
      }
    },
  );
}
