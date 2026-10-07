import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { MAX_FILE_SIZE_BYTES } from "../constants.js";
import { extract_file_structure, FileStructureSchema, SUPPORTED_EXTENSIONS } from "../parser/index.js";
import type { ToolContext } from "./context.js";
import { formatFileStructureMarkdown } from "./formatters.js";
import { errorResult, successResult } from "./responses.js";
import { GetFileStructureInputSchema, type GetFileStructureInput } from "./schemas.js";

export const GET_FILE_STRUCTURE_TOOL = "get_file_structure";

function describeTool(context: ToolContext): string {
  const sandbox = context.pathPolicy.isRestricted
    ? `\n\nThis server can only read inside: ${context.pathPolicy.allowedRoots.join(", ")}.`
    : "";
  return `Outline one JavaScript/TypeScript source file from its Tree-sitter syntax tree: imports (ESM, CommonJS require, re-exports), classes with their properties and methods, top-level functions (declarations, arrow functions, function expressions, CommonJS exports) and TypeScript interfaces / type aliases / enums, each with 1-based line ranges and signatures exactly as written.

Use it to learn a file's API and dependencies without reading the whole file, and to find which lines to read next. It does not return function bodies or nested local helpers.

Args:
  - filePath (string): file to analyse (${SUPPORTED_EXTENSIONS.join(" ")}). Absolute path recommended.
  - responseFormat ('markdown' | 'json'): 'markdown' (default) is a compact outline; 'json' returns the full object.

Returns (structuredContent, identical to the 'json' text):
  { filePath, language, lineCount, hasSyntaxErrors, syntaxErrorLines[],
    imports[{ source, kind: esm|commonjs|re-export, typeOnly, specifiers[{ kind, name, importedName? }], line }],
    classes[{ name, exported, defaultExport, abstract, extends?, implements[], properties[{ name, static, readonly, visibility?, type?, line }],
              methods[{ name, kind: constructor|method|getter|setter, static, async, abstract, visibility?, signature, startLine, endLine }], startLine, endLine }],
    functions[{ name, kind: function|generator|arrow|function_expression|signature, async, exported, defaultExport, signature, startLine, endLine }],
    types[{ name, kind: interface|type_alias|enum, exported, startLine, endLine }] }

Examples:
  - "What does src/server.ts export?" -> { filePath: "/repo/src/server.ts" }
  - Need exact field values for code generation -> add responseFormat: "json"

Errors (isError=true, text starts with 'Error [CODE]'): FILE_NOT_FOUND, PERMISSION_DENIED, NOT_A_FILE,
FILE_TOO_LARGE (> ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MiB), PATH_OUTSIDE_ROOTS, INVALID_PATH. Unsupported extensions are rejected by input validation.
If hasSyntaxErrors is true the outline is best-effort.${sandbox}`;
}

export function registerGetFileStructureTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    GET_FILE_STRUCTURE_TOOL,
    {
      title: "Get File Structure (AST outline)",
      description: describeTool(context),
      inputSchema: GetFileStructureInputSchema,
      outputSchema: FileStructureSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: GetFileStructureInput): Promise<CallToolResult> => {
      try {
        const filePath = await context.pathPolicy.resolve(input.filePath);
        // A restricted path is already canonical, so its last component is not a
        // symlink: refusing to follow one closes the window between that check and
        // this read. Unrestricted mode may legitimately be pointed at a symlink.
        const structure = await extract_file_structure(filePath, { denySymlinks: context.pathPolicy.isRestricted });
        const text = input.responseFormat === "json" ? JSON.stringify(structure, null, 2) : formatFileStructureMarkdown(structure);
        return successResult(text, structure);
      } catch (error) {
        return errorResult(error, context.logger);
      }
    },
  );
}
