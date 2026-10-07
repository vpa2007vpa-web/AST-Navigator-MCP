/**
 * Public API of the parsing engine. The tool layer only imports from here.
 */
import path from "node:path";

import { AstNavigatorError, ErrorCode } from "../errors.js";
import { listModuleReferences, type ModuleReferenceFile } from "./dependencies.js";
import { readSourceFile, type ReadSourceFileOptions } from "./fileReader.js";
import { detectLanguage, SUPPORTED_EXTENSIONS } from "./languages.js";
import type { FileStructure, LanguageId } from "./model.js";
import { buildFileStructure } from "./structureExtractor.js";
import { parseSource } from "./treeSitterParser.js";

export { listModuleReferences, MODULE_REFERENCE_KINDS } from "./dependencies.js";
export type { ModuleReference, ModuleReferenceFile, ModuleReferenceKind, ModuleReferenceScan } from "./dependencies.js";
export { listDefinitions } from "./definitions.js";
export { readSourceFile, toFileAccessError } from "./fileReader.js";
export type { ReadSourceFileOptions, SourceFile } from "./fileReader.js";
export { detectLanguage, isSupportedSourceFile, SUPPORTED_EXTENSIONS } from "./languages.js";
export * from "./model.js";

/** Parses already-loaded source text. Pure CPU work: no I/O. */
export function analyzeSource(source: string, filePath: string, language: LanguageId): FileStructure {
  const tree = parseSource(source, language, filePath);
  return buildFileStructure(tree, source, filePath, language);
}

function requireLanguage(absolutePath: string): LanguageId {
  const language = detectLanguage(absolutePath);
  if (language === undefined) {
    const extension = path.extname(absolutePath) || "(none)";
    throw new AstNavigatorError(ErrorCode.UNSUPPORTED_LANGUAGE, `Unsupported file extension '${extension}': ${absolutePath}`, {
      hint: `Supported extensions: ${SUPPORTED_EXTENSIONS.join(", ")}.`,
    });
  }
  return language;
}

/**
 * Reads a local JS/TS file and returns a lightweight JSON outline of its
 * imports, classes (with members), functions and type declarations.
 *
 * @throws AstNavigatorError UNSUPPORTED_LANGUAGE, FILE_NOT_FOUND, PERMISSION_DENIED,
 *         NOT_A_FILE, FILE_TOO_LARGE, READ_FAILED or PARSE_FAILED.
 */
export async function extract_file_structure(filePath: string, options: ReadSourceFileOptions = {}): Promise<FileStructure> {
  const absolutePath = path.resolve(filePath);
  const language = requireLanguage(absolutePath);
  const file = await readSourceFile(absolutePath, options);
  return analyzeSource(file.content, absolutePath, language);
}

/**
 * Reads a local JS/TS file and lists every module it references: ES imports,
 * re-exports, `require` calls and dynamic `import()`, anywhere in the file.
 *
 * @throws AstNavigatorError (same codes as extract_file_structure).
 */
export async function extract_module_references(filePath: string, options: ReadSourceFileOptions = {}): Promise<ModuleReferenceFile> {
  const absolutePath = path.resolve(filePath);
  const language = requireLanguage(absolutePath);
  const file = await readSourceFile(absolutePath, options);
  const scan = listModuleReferences(parseSource(file.content, language, absolutePath));
  return { filePath: absolutePath, language, ...scan };
}
