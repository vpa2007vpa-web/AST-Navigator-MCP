/**
 * Zod contracts for every tool. Inputs are validated by the MCP SDK before a
 * handler runs; handler parameters are typed with `z.infer` of these schemas,
 * so the runtime check and the static type can never drift apart.
 */
import { z } from "zod";

import {
  DEFINITION_KINDS,
  DefinitionKindSchema,
  DefinitionSchema,
  isSupportedSourceFile,
  LanguageIdSchema,
  MODULE_REFERENCE_KINDS,
  SUPPORTED_EXTENSIONS,
} from "../parser/index.js";

export const RESPONSE_FORMATS = ["markdown", "json"] as const;

const ResponseFormatSchema = z
  .enum(RESPONSE_FORMATS)
  .default("markdown")
  .describe("'markdown' (default): compact outline for reading. 'json': full structured data.");

export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

/**
 * Shape constraints for any filesystem path received from a client.
 *
 * This layer can only reject paths that are malformed in themselves; it is
 * deliberately *not* where traversal is stopped. "../" is a legal path
 * fragment, and whether a path escapes the workspace depends on the configured
 * roots, which the schema knows nothing about - that decision belongs to
 * PathPolicy (tools/pathPolicy.ts), which normalises the path, follows symlinks
 * and checks containment against every allowed root.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
/** The \\?\ and \\.\ prefixes bypass Win32 path normalisation, so ".." survives to the syscall. */
const WINDOWS_DEVICE_NAMESPACE = /^[\\/]{2}[.?][\\/]/u;

const PathSchema = z
  .string()
  .trim()
  .min(1, "Path must not be empty.")
  .max(4096, "Path is too long (max 4096 characters).")
  .refine((value) => !CONTROL_CHARACTERS.test(value), "Path must not contain control characters (including NUL).")
  .refine((value) => !WINDOWS_DEVICE_NAMESPACE.test(value), "Windows device-namespace paths are not accepted.");

/** A path that must also name a JavaScript/TypeScript source file. */
const SourceFilePathSchema = PathSchema.refine(isSupportedSourceFile, {
  message: `Unsupported file extension. Supported: ${SUPPORTED_EXTENSIONS.join(", ")}.`,
});

// ---------------------------------------------------------------------------
// get_file_structure
// ---------------------------------------------------------------------------

export const GetFileStructureInputSchema = z.strictObject({
  filePath: SourceFilePathSchema.describe(
    "Source file to outline. Absolute path recommended, e.g. 'C:\\repo\\src\\index.ts' or '/home/me/repo/src/index.ts'. " +
      "Relative paths resolve against the server's first allowed root.",
  ),
  responseFormat: ResponseFormatSchema,
});

export type GetFileStructureInput = z.infer<typeof GetFileStructureInputSchema>;

// ---------------------------------------------------------------------------
// find_definition
// ---------------------------------------------------------------------------

export const MATCH_MODES = ["exact", "prefix", "contains"] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

export const FindDefinitionInputSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, "Name must not be empty.")
    .max(200, "Name is too long (max 200 characters).")
    .regex(
      /^[\p{L}\p{N}_$#.]+$/u,
      "Name may only contain identifier characters ('_', '$', '#' for private members) and '.' for qualified names such as 'UserService.create'.",
    )
    .describe("Symbol to find, e.g. 'UserService', 'parseConfig', or a qualified method name 'UserService.create'."),
  directory: PathSchema.optional().describe(
    "Directory searched recursively. Absolute path recommended. Defaults to the server's first allowed root.",
  ),
  matchMode: z
    .enum(MATCH_MODES)
    .default("exact")
    .describe("'exact' (default), 'prefix' (name starts with) or 'contains' (substring)."),
  caseSensitive: z.boolean().default(true).describe("Case-sensitive matching (default true)."),
  kinds: z
    .array(DefinitionKindSchema)
    .min(1)
    .max(DEFINITION_KINDS.length)
    .optional()
    .describe(`Only return these definition kinds: ${DEFINITION_KINDS.join(", ")}. Omit for all.`),
  limit: z.number().int().min(1).max(200).default(50).describe("Maximum results to return (1-200, default 50)."),
  offset: z.number().int().min(0).default(0).describe("Results to skip, for pagination (default 0)."),
  responseFormat: ResponseFormatSchema,
});

export type FindDefinitionInput = z.infer<typeof FindDefinitionInputSchema>;

export const FindDefinitionOutputSchema = z.object({
  query: z.string(),
  directory: z.string().describe("Absolute directory that was searched"),
  matchMode: z.enum(MATCH_MODES),
  total: z.number().int().nonnegative().describe("Total matches found"),
  count: z.number().int().nonnegative().describe("Matches in this page"),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().optional().describe("Offset for the next page, when hasMore"),
  filesScanned: z.number().int().nonnegative().describe("Candidate source files found under the directory"),
  filesParsed: z.number().int().nonnegative().describe("Files that mentioned the name and were parsed"),
  skippedFiles: z.number().int().nonnegative().describe("Files skipped because they were unreadable or too large"),
  scanTruncated: z.boolean().describe("True if the scan stopped at the file limit; search a narrower directory"),
  results: z.array(DefinitionSchema),
});

export type FindDefinitionOutput = z.infer<typeof FindDefinitionOutputSchema>;

// ---------------------------------------------------------------------------
// analyze_dependencies
// ---------------------------------------------------------------------------

export const UNRESOLVED_REASONS = ["not_found", "outside_roots", "invalid"] as const;
export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];

const ModuleReferenceKindSchema = z.enum(MODULE_REFERENCE_KINDS);
const LineListSchema = z.array(z.number().int().positive()).describe("1-based lines where the module is referenced");

export const AnalyzeDependenciesInputSchema = z.strictObject({
  filePath: SourceFilePathSchema.describe(
    "Source file whose local dependencies to list. Absolute path recommended. Relative paths resolve against the server's first allowed root.",
  ),
  includeTypeOnly: z
    .boolean()
    .default(true)
    .describe("Include `import type` / `export type ... from` references, which are erased at compile time (default true)."),
  responseFormat: ResponseFormatSchema,
});

export type AnalyzeDependenciesInput = z.infer<typeof AnalyzeDependenciesInputSchema>;

export const InternalDependencySchema = z.object({
  path: z.string().describe("Absolute path of the local file this file depends on"),
  specifiers: z.array(z.string()).describe("Specifiers as written in the source that resolve to this file"),
  kinds: z.array(ModuleReferenceKindSchema),
  typeOnly: z.boolean().describe("True when every reference is type-only (no runtime load)"),
  lines: LineListSchema,
});

export const UnresolvedDependencySchema = z.object({
  specifier: z.string(),
  reason: z
    .enum(UNRESOLVED_REASONS)
    .describe("'not_found': no matching file; 'outside_roots': it points outside the allowed roots; 'invalid': not a usable path"),
  kinds: z.array(ModuleReferenceKindSchema),
  lines: LineListSchema,
});

export const AnalyzeDependenciesOutputSchema = z.object({
  filePath: z.string().describe("Absolute path of the analysed file"),
  language: LanguageIdSchema,
  hasSyntaxErrors: z.boolean().describe("True if the file has syntax errors; references inside broken code may be missed"),
  dependencies: z.array(InternalDependencySchema).describe("Local files this file loads, in order of first reference"),
  unresolved: z.array(UnresolvedDependencySchema).describe("Local specifiers that do not resolve to a file inside the allowed roots"),
  externalCount: z
    .number()
    .int()
    .nonnegative()
    .describe("Distinct non-local specifiers ignored: packages (node_modules), node: built-ins, path aliases"),
  nonLiteralCount: z
    .number()
    .int()
    .nonnegative()
    .describe("require()/import() calls with a computed argument, which cannot be followed statically"),
  truncated: z.boolean().describe("True if the file has more distinct local specifiers than are resolved per call"),
});

export type InternalDependency = z.infer<typeof InternalDependencySchema>;
export type UnresolvedDependency = z.infer<typeof UnresolvedDependencySchema>;
export type AnalyzeDependenciesOutput = z.infer<typeof AnalyzeDependenciesOutputSchema>;
