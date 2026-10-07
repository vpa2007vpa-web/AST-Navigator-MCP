import { stat } from "node:fs/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { IGNORED_DIRECTORIES, MAX_FILE_SIZE_BYTES, MAX_FILES_SCANNED, READ_CONCURRENCY } from "../constants.js";
import { AstNavigatorError, ErrorCode } from "../errors.js";
import {
  analyzeSource,
  type Definition,
  type DefinitionKind,
  detectLanguage,
  listDefinitions,
  readSourceFile,
  toFileAccessError,
} from "../parser/index.js";
import type { ToolContext } from "./context.js";
import { scanSourceFiles } from "./directoryWalker.js";
import { formatFindDefinitionMarkdown } from "./formatters.js";
import { errorResult, successResult } from "./responses.js";
import {
  FindDefinitionInputSchema,
  FindDefinitionOutputSchema,
  type FindDefinitionInput,
  type FindDefinitionOutput,
  type MatchMode,
} from "./schemas.js";

export const FIND_DEFINITION_TOOL = "find_definition";

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface Query {
  readonly text: string;
  readonly qualified: boolean;
  readonly mode: MatchMode;
  readonly caseSensitive: boolean;
  readonly kinds: ReadonlySet<DefinitionKind> | undefined;
}

function buildQuery(input: FindDefinitionInput): Query {
  return {
    text: input.name,
    qualified: input.name.includes("."),
    mode: input.matchMode,
    caseSensitive: input.caseSensitive,
    kinds: input.kinds === undefined ? undefined : new Set(input.kinds),
  };
}

/** A qualified query ("Class.method") is compared against qualifiedName, otherwise against name. */
function candidateName(definition: Definition, query: Query): string {
  return query.qualified ? definition.qualifiedName : definition.name;
}

function matches(definition: Definition, query: Query): boolean {
  if (query.kinds !== undefined && !query.kinds.has(definition.kind)) {
    return false;
  }
  const candidate = query.caseSensitive ? candidateName(definition, query) : candidateName(definition, query).toLowerCase();
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
  switch (query.mode) {
    case "exact":
      return candidate === needle;
    case "prefix":
      return candidate.startsWith(needle);
    case "contains":
      return candidate.includes(needle);
  }
}

/** 0 = exact, 1 = exact ignoring case, 2 = prefix, 3 = substring. Lower is better. */
function relevance(definition: Definition, query: Query): number {
  const candidate = candidateName(definition, query);
  if (candidate === query.text) {
    return 0;
  }
  const lowerCandidate = candidate.toLowerCase();
  const lowerNeedle = query.text.toLowerCase();
  if (lowerCandidate === lowerNeedle) {
    return 1;
  }
  return lowerCandidate.startsWith(lowerNeedle) ? 2 : 3;
}

/**
 * Cheap text pre-filter: a file can only declare the symbol if every segment
 * of the name appears in its text. This skips parsing for the vast majority
 * of files in a repository.
 */
function createTextPrefilter(query: Query): (content: string) => boolean {
  const segments = query.text.split(".").filter((segment) => segment.length > 0);
  if (query.caseSensitive) {
    return (content) => segments.every((segment) => content.includes(segment));
  }
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  return (content) => {
    const lowerContent = content.toLowerCase();
    return lowerSegments.every((segment) => lowerContent.includes(segment));
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Runs `worker` over `items` with at most `concurrency` promises in flight. */
async function forEachConcurrently<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item !== undefined) {
        await worker(item);
      }
    }
  });
  await Promise.all(runners);
}

async function resolveSearchDirectory(input: FindDefinitionInput, context: ToolContext): Promise<string> {
  const requested = input.directory ?? context.pathPolicy.defaultDirectory;
  if (requested === undefined) {
    throw new AstNavigatorError(ErrorCode.MISSING_DIRECTORY, "No 'directory' was given and the server has no configured root.", {
      hint: "Pass the absolute path of the repository (or sub-directory) to search.",
    });
  }
  const directory = await context.pathPolicy.resolve(requested);
  try {
    const stats = await stat(directory);
    if (!stats.isDirectory()) {
      throw new AstNavigatorError(ErrorCode.NOT_A_DIRECTORY, `Expected a directory but got a file: ${directory}`, {
        hint: "Use get_file_structure to inspect a single file.",
      });
    }
  } catch (error) {
    throw toFileAccessError(error, directory);
  }
  return directory;
}

export async function findDefinitions(input: FindDefinitionInput, context: ToolContext): Promise<FindDefinitionOutput> {
  const directory = await resolveSearchDirectory(input, context);
  const query = buildQuery(input);
  const prefilter = createTextPrefilter(query);
  const scan = await scanSourceFiles(directory);

  const found: Definition[] = [];
  let filesParsed = 0;
  let skippedFiles = 0;

  await forEachConcurrently(scan.files, READ_CONCURRENCY, async (filePath) => {
    const language = detectLanguage(filePath);
    if (language === undefined) {
      return;
    }
    let content: string;
    try {
      // The walker never yields a symlink, so refusing to follow one here can
      // only reject a link that appeared after the directory listing.
      ({ content } = await readSourceFile(filePath, { denySymlinks: true }));
    } catch (error) {
      skippedFiles += 1;
      context.logger.debug("Skipping unreadable file", { filePath, reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!prefilter(content)) {
      return;
    }
    filesParsed += 1;
    try {
      for (const definition of listDefinitions(analyzeSource(content, filePath, language))) {
        if (matches(definition, query)) {
          found.push(definition);
        }
      }
    } catch (error) {
      skippedFiles += 1;
      context.logger.warn("Skipping file that failed to parse", { filePath, error });
    }
  });

  // Deterministic order regardless of read concurrency: relevance, then location.
  const ranked = found
    .map((definition) => ({ definition, rank: relevance(definition, query) }))
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.definition.filePath.localeCompare(right.definition.filePath) ||
        left.definition.startLine - right.definition.startLine,
    )
    .map(({ definition }) => definition);

  const page = ranked.slice(input.offset, input.offset + input.limit);
  const hasMore = input.offset + page.length < ranked.length;

  return {
    query: input.name,
    directory,
    matchMode: input.matchMode,
    total: ranked.length,
    count: page.length,
    offset: input.offset,
    hasMore,
    ...(hasMore ? { nextOffset: input.offset + page.length } : {}),
    filesScanned: scan.files.length,
    filesParsed,
    skippedFiles,
    scanTruncated: scan.truncated,
    results: page.map((definition) => ({ ...definition })),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function describeTool(context: ToolContext): string {
  const defaultDirectory = context.pathPolicy.defaultDirectory;
  const directoryDefault = defaultDirectory === undefined ? "required (no server root configured)" : `defaults to ${defaultDirectory}`;
  const sandbox = context.pathPolicy.isRestricted
    ? `\n\nThis server can only read inside: ${context.pathPolicy.allowedRoots.join(", ")}.`
    : "";
  return `Find where classes, functions, methods, interfaces, type aliases and enums are DEFINED, by name, across every JavaScript/TypeScript file under a directory (recursive). Matching runs on parsed declarations, not raw text, so call sites, comments and strings never match.

Use it to jump from a symbol name to its definition(s), then call get_file_structure on a returned filePath for surrounding context. Not for finding usages/references.

Args:
  - name (string): symbol to find, e.g. "UserService", "parseConfig", or a qualified method "UserService.create".
  - directory (string, optional): directory to search; ${directoryDefault}.
  - matchMode ('exact' | 'prefix' | 'contains'): default 'exact'.
  - caseSensitive (boolean): default true.
  - kinds (array, optional): any of class, function, method, interface, type_alias, enum.
  - limit (1-200, default 50) and offset (default 0): pagination.
  - responseFormat ('markdown' | 'json'): default 'markdown'.

Returns (structuredContent):
  { query, directory, matchMode, total, count, offset, hasMore, nextOffset?, filesScanned, filesParsed, skippedFiles, scanTruncated,
    results[{ name, qualifiedName, kind, container?, exported, signature?, filePath, startLine, endLine }] }
  Results are ordered by relevance (exact match first), then file path and line.

Examples:
  - "Where is UserService defined?" -> { name: "UserService", kinds: ["class"] }
  - "Which functions start with handle?" -> { name: "handle", matchMode: "prefix", kinds: ["function", "method"] }

Skipped while scanning: ${[...IGNORED_DIRECTORIES].join(", ")}, dot-directories (.git, .next, ...), symbolic links, minified bundles and files over ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MiB. A scan stops after ${MAX_FILES_SCANNED} files (scanTruncated=true).

Errors (isError=true, text starts with 'Error [CODE]'): FILE_NOT_FOUND, NOT_A_DIRECTORY, MISSING_DIRECTORY, PERMISSION_DENIED, PATH_OUTSIDE_ROOTS, INVALID_PATH.${sandbox}`;
}

export function registerFindDefinitionTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    FIND_DEFINITION_TOOL,
    {
      title: "Find Definition",
      description: describeTool(context),
      inputSchema: FindDefinitionInputSchema,
      outputSchema: FindDefinitionOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: FindDefinitionInput): Promise<CallToolResult> => {
      try {
        const output = await findDefinitions(input, context);
        const text = input.responseFormat === "json" ? JSON.stringify(output, null, 2) : formatFindDefinitionMarkdown(output);
        return successResult(text, output);
      } catch (error) {
        return errorResult(error, context.logger);
      }
    },
  );
}
