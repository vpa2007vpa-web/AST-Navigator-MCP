/**
 * Data contract produced by the parser.
 *
 * The Zod schemas are the single source of truth: they are published as the
 * tools' `outputSchema` (so clients receive a typed `structuredContent`), and
 * the TypeScript types are inferred from them and made deeply readonly.
 */
import { z } from "zod";

/** Recursively marks every property and array of `T` as readonly. */
export type DeepReadonly<T> = T extends (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const LANGUAGE_IDS = ["javascript", "typescript", "tsx"] as const;
export const LanguageIdSchema = z.enum(LANGUAGE_IDS).describe("Grammar used to parse the file");
export type LanguageId = z.infer<typeof LanguageIdSchema>;

const lineNumber = z.number().int().positive();

/** 1-based, inclusive line span shared by every declaration. */
const lineSpan = {
  startLine: lineNumber.describe("1-based first line of the declaration"),
  endLine: lineNumber.describe("1-based last line of the declaration (inclusive)"),
};

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export const ImportSpecifierSchema = z.object({
  kind: z.enum(["default", "named", "namespace"]),
  name: z.string().describe("Local binding name ('*' for a bare `export * from`)"),
  importedName: z.string().optional().describe("Original exported name, present only when aliased (`a as b`)"),
  typeOnly: z.boolean().optional().describe("True for inline `type` specifiers"),
});

export const ImportInfoSchema = z.object({
  source: z.string().describe("Module specifier, e.g. 'node:fs' or './utils.js'"),
  kind: z.enum(["esm", "commonjs", "re-export"]),
  typeOnly: z.boolean().describe("True for `import type` / `export type ... from`"),
  specifiers: z.array(ImportSpecifierSchema).describe("Empty for side-effect imports"),
  line: lineNumber,
});

// ---------------------------------------------------------------------------
// Functions & classes
// ---------------------------------------------------------------------------

export const FUNCTION_KINDS = ["function", "generator", "arrow", "function_expression", "signature"] as const;

export const FunctionInfoSchema = z.object({
  name: z.string(),
  kind: z.enum(FUNCTION_KINDS),
  async: z.boolean(),
  exported: z.boolean(),
  defaultExport: z.boolean(),
  signature: z.string().describe("Type parameters, parameter list and return type as written in source"),
  ...lineSpan,
});

export const METHOD_KINDS = ["constructor", "method", "getter", "setter"] as const;
export const VISIBILITIES = ["public", "protected", "private"] as const;

export const MethodInfoSchema = z.object({
  name: z.string(),
  kind: z.enum(METHOD_KINDS),
  static: z.boolean(),
  async: z.boolean(),
  abstract: z.boolean(),
  visibility: z.enum(VISIBILITIES).optional().describe("TypeScript modifier or ES `#private`; omitted when implicit"),
  signature: z.string(),
  ...lineSpan,
});

export const PropertyInfoSchema = z.object({
  name: z.string(),
  static: z.boolean(),
  readonly: z.boolean(),
  visibility: z.enum(VISIBILITIES).optional(),
  type: z.string().optional().describe("Type annotation as written in source"),
  line: lineNumber,
});

export const ClassInfoSchema = z.object({
  name: z.string(),
  exported: z.boolean(),
  defaultExport: z.boolean(),
  abstract: z.boolean(),
  extends: z.string().optional().describe("Superclass expression as written in source"),
  implements: z.array(z.string()),
  properties: z.array(PropertyInfoSchema),
  methods: z.array(MethodInfoSchema),
  ...lineSpan,
});

export const TYPE_KINDS = ["interface", "type_alias", "enum"] as const;

export const TypeInfoSchema = z.object({
  name: z.string(),
  kind: z.enum(TYPE_KINDS),
  exported: z.boolean(),
  ...lineSpan,
});

// ---------------------------------------------------------------------------
// File structure (output of extract_file_structure)
// ---------------------------------------------------------------------------

export const FileStructureSchema = z.object({
  filePath: z.string().describe("Absolute path of the analysed file"),
  language: LanguageIdSchema,
  lineCount: z.number().int().nonnegative(),
  hasSyntaxErrors: z.boolean().describe("Tree-sitter recovered from syntax errors; the outline may be incomplete"),
  syntaxErrorLines: z.array(lineNumber).describe("First lines where syntax errors were detected"),
  imports: z.array(ImportInfoSchema),
  classes: z.array(ClassInfoSchema),
  functions: z.array(FunctionInfoSchema),
  types: z.array(TypeInfoSchema).describe("TypeScript interfaces, type aliases and enums"),
});

// ---------------------------------------------------------------------------
// Flattened definitions (used by find_definition)
// ---------------------------------------------------------------------------

export const DEFINITION_KINDS = ["class", "function", "method", "interface", "type_alias", "enum"] as const;
export const DefinitionKindSchema = z.enum(DEFINITION_KINDS);

export const DefinitionSchema = z.object({
  name: z.string(),
  qualifiedName: z.string().describe("`Container.member` for methods, otherwise equal to name"),
  kind: DefinitionKindSchema,
  container: z.string().optional().describe("Owning class for methods"),
  exported: z.boolean(),
  signature: z.string().optional(),
  filePath: z.string(),
  ...lineSpan,
});

export type ImportSpecifier = DeepReadonly<z.infer<typeof ImportSpecifierSchema>>;
export type ImportInfo = DeepReadonly<z.infer<typeof ImportInfoSchema>>;
export type FunctionKind = (typeof FUNCTION_KINDS)[number];
export type FunctionInfo = DeepReadonly<z.infer<typeof FunctionInfoSchema>>;
export type MethodKind = (typeof METHOD_KINDS)[number];
export type Visibility = (typeof VISIBILITIES)[number];
export type MethodInfo = DeepReadonly<z.infer<typeof MethodInfoSchema>>;
export type PropertyInfo = DeepReadonly<z.infer<typeof PropertyInfoSchema>>;
export type ClassInfo = DeepReadonly<z.infer<typeof ClassInfoSchema>>;
export type TypeKind = (typeof TYPE_KINDS)[number];
export type TypeInfo = DeepReadonly<z.infer<typeof TypeInfoSchema>>;
export type FileStructure = DeepReadonly<z.infer<typeof FileStructureSchema>>;
export type DefinitionKind = z.infer<typeof DefinitionKindSchema>;
export type Definition = DeepReadonly<z.infer<typeof DefinitionSchema>>;
