/**
 * Converts a Tree-sitter syntax tree into the lightweight `FileStructure`
 * outline: imports, classes (with members), functions and TS type
 * declarations.
 *
 * Scope is deliberately the module's *top level*: nested helpers and
 * closures are implementation details and would mostly add noise to the
 * context of the calling model. The walk is a single pass over the root's
 * children (plus class bodies), so it is O(top-level nodes).
 *
 * Node type / field names follow tree-sitter-javascript 0.25 and
 * tree-sitter-typescript 0.23 (the TS grammar extends the JS one).
 */
import { MAX_REPORTED_SYNTAX_ERRORS, MAX_SIGNATURE_LENGTH } from "../constants.js";
import type {
  ClassInfo,
  FileStructure,
  FunctionInfo,
  FunctionKind,
  ImportInfo,
  ImportSpecifier,
  LanguageId,
  MethodInfo,
  MethodKind,
  PropertyInfo,
  TypeInfo,
  TypeKind,
  Visibility,
} from "./model.js";
import type { SyntaxNode, SyntaxTree } from "./treeSitterParser.js";

// ---------------------------------------------------------------------------
// Walk state
// ---------------------------------------------------------------------------

interface ExportContext {
  readonly exported: boolean;
  readonly defaultExport: boolean;
}

const NOT_EXPORTED: ExportContext = { exported: false, defaultExport: false };
const NAMED_EXPORT: ExportContext = { exported: true, defaultExport: false };

/** Collections are filled during the walk of one tree, then frozen into a FileStructure. */
interface Accumulator {
  readonly imports: ImportInfo[];
  readonly classes: ClassInfo[];
  readonly functions: FunctionInfo[];
  /** Overload / ambient signatures; kept only when no implementation exists. */
  readonly signatures: FunctionInfo[];
  readonly types: TypeInfo[];
  /** Names exported after their declaration: `export { a }`, `module.exports = { a }`. */
  readonly lateExports: Set<string>;
  /** Names exported as default after their declaration: `export default a`. */
  readonly lateDefaultExports: Set<string>;
}

const FUNCTION_NODE_KINDS: ReadonlyMap<string, FunctionKind> = new Map<string, FunctionKind>([
  ["function_declaration", "function"],
  ["generator_function_declaration", "generator"],
  ["function_signature", "signature"],
  ["arrow_function", "arrow"],
  ["function_expression", "function_expression"],
  ["function", "function_expression"], // name used by older grammar releases
  ["generator_function", "generator"],
]);

/** Function forms that appear as statements (as opposed to expressions bound to a variable). */
const FUNCTION_STATEMENT_TYPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_signature",
]);

const TYPE_NODE_KINDS: ReadonlyMap<string, TypeKind> = new Map<string, TypeKind>([
  ["interface_declaration", "interface"],
  ["type_alias_declaration", "type_alias"],
  ["enum_declaration", "enum"],
]);

const CLASS_NODE_TYPES: ReadonlySet<string> = new Set(["class_declaration", "abstract_class_declaration", "class"]);

const VISIBILITY_KEYWORDS: ReadonlySet<string> = new Set<Visibility>(["public", "protected", "private"]);

/** Wrappers that do not change what an initializer *is*: `(x)`, `x as T`, `x satisfies T`, `x!`. */
const TRANSPARENT_EXPRESSIONS: ReadonlySet<string> = new Set([
  "parenthesized_expression",
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
]);

// ---------------------------------------------------------------------------
// Small node helpers
// ---------------------------------------------------------------------------

const startLine = (node: SyntaxNode): number => node.startPosition.row + 1;
const endLine = (node: SyntaxNode): number => node.endPosition.row + 1;

/** True when `node` has an anonymous (keyword) child such as `async`, `static`, `default`. */
export function hasKeyword(node: SyntaxNode, keyword: string): boolean {
  return node.children.some((child) => !child.isNamed && child.type === keyword);
}

function findNamedChild(node: SyntaxNode, type: string): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === type);
}

/** Collapses whitespace so multi-line signatures fit on one line, then truncates. */
function compact(text: string, maxLength: number = MAX_SIGNATURE_LENGTH): string {
  const collapsed = text
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/,?\s+\)/g, ")")
    .trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 3)}...` : collapsed;
}

/** Value of a string literal or of a template literal without substitutions; undefined otherwise. */
export function stringLiteralValue(node: SyntaxNode | null | undefined): string | undefined {
  if (node === null || node === undefined) {
    return undefined;
  }
  if (node.type === "string") {
    return node.text.slice(1, -1);
  }
  if (node.type === "template_string" && node.namedChildren.every((child) => child.type === "string_fragment")) {
    return node.text.slice(1, -1);
  }
  return undefined;
}

function unwrapExpression(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (TRANSPARENT_EXPRESSIONS.has(current.type)) {
    const inner = current.namedChildren[0];
    if (inner === undefined) {
      break;
    }
    current = inner;
  }
  return current;
}

/** Type parameters + parameter list + return type, exactly as written. */
function functionSignature(node: SyntaxNode): string {
  const typeParameters = node.childForFieldName("type_parameters")?.text ?? "";
  const parameterList = node.childForFieldName("parameters");
  const singleParameter = node.childForFieldName("parameter"); // `x => ...`
  const parameters = parameterList?.text ?? (singleParameter === null ? "()" : `(${singleParameter.text})`);
  const returnType = node.childForFieldName("return_type")?.text ?? "";
  return compact(`${typeParameters}${parameters}${returnType}`);
}

function resolveVisibility(member: SyntaxNode, nameNode: SyntaxNode | null): Visibility | undefined {
  const modifier = findNamedChild(member, "accessibility_modifier")?.text;
  if (modifier !== undefined && VISIBILITY_KEYWORDS.has(modifier)) {
    return modifier as Visibility;
  }
  return nameNode?.type === "private_property_identifier" ? "private" : undefined;
}

/** `require("x")` → "x"; anything else → undefined. */
function requireCallSource(node: SyntaxNode | null | undefined): string | undefined {
  if (node?.type !== "call_expression") {
    return undefined;
  }
  const callee = node.childForFieldName("function");
  if (callee?.type !== "identifier" || callee.text !== "require") {
    return undefined;
  }
  return stringLiteralValue(node.childForFieldName("arguments")?.namedChildren[0]);
}

// ---------------------------------------------------------------------------
// Describers: syntax node → model object
// ---------------------------------------------------------------------------

function describeFunction(node: SyntaxNode, name: string, spanNode: SyntaxNode, context: ExportContext): FunctionInfo {
  return {
    name,
    kind: FUNCTION_NODE_KINDS.get(node.type) ?? "function",
    async: hasKeyword(node, "async"),
    exported: context.exported,
    defaultExport: context.defaultExport,
    signature: functionSignature(node),
    startLine: startLine(spanNode),
    endLine: endLine(spanNode),
  };
}

function describeMethod(member: SyntaxNode, isAbstractSignature: boolean): MethodInfo {
  const nameNode = member.childForFieldName("name");
  const name = nameNode?.text ?? "<anonymous>";
  const kind: MethodKind =
    name === "constructor" ? "constructor" : hasKeyword(member, "get") ? "getter" : hasKeyword(member, "set") ? "setter" : "method";
  const visibility = resolveVisibility(member, nameNode);
  return {
    name,
    kind,
    static: hasKeyword(member, "static"),
    async: hasKeyword(member, "async"),
    abstract: isAbstractSignature || hasKeyword(member, "abstract"),
    ...(visibility === undefined ? {} : { visibility }),
    signature: functionSignature(member),
    startLine: startLine(member),
    endLine: endLine(member),
  };
}

function describeProperty(member: SyntaxNode): PropertyInfo | undefined {
  // TS grammar: public_field_definition(name:)  |  JS grammar: field_definition(property:)
  const nameNode = member.childForFieldName("name") ?? member.childForFieldName("property");
  if (nameNode === null) {
    return undefined;
  }
  const visibility = resolveVisibility(member, nameNode);
  const typeAnnotation = member.childForFieldName("type")?.text.replace(/^:\s*/, "");
  return {
    name: nameNode.text,
    static: hasKeyword(member, "static"),
    readonly: hasKeyword(member, "readonly"),
    ...(visibility === undefined ? {} : { visibility }),
    ...(typeAnnotation === undefined ? {} : { type: compact(typeAnnotation) }),
    line: startLine(member),
  };
}

interface Heritage {
  readonly superclass: string | undefined;
  readonly interfaces: readonly string[];
}

function describeHeritage(heritage: SyntaxNode | undefined): Heritage {
  let superclass: string | undefined;
  const interfaces: string[] = [];
  for (const clause of heritage?.namedChildren ?? []) {
    if (clause.type === "extends_clause") {
      superclass = compact(clause.text.replace(/^extends\s+/, "")); // TS grammar
    } else if (clause.type === "implements_clause") {
      interfaces.push(...clause.namedChildren.map((type) => compact(type.text)));
    } else if (clause.type !== "comment") {
      superclass ??= compact(clause.text); // JS grammar: the superclass expression itself
    }
  }
  return { superclass, interfaces };
}

function describeClass(node: SyntaxNode, context: ExportContext, bindingName?: string): ClassInfo | undefined {
  const name = bindingName ?? node.childForFieldName("name")?.text ?? (context.defaultExport ? "default" : undefined);
  if (name === undefined) {
    return undefined; // anonymous class expression: nothing to navigate to
  }
  const { superclass, interfaces } = describeHeritage(findNamedChild(node, "class_heritage"));
  const properties: PropertyInfo[] = [];
  const methods: MethodInfo[] = [];

  for (const member of node.childForFieldName("body")?.namedChildren ?? []) {
    switch (member.type) {
      case "method_definition":
        methods.push(describeMethod(member, false));
        break;
      case "abstract_method_signature":
        methods.push(describeMethod(member, true));
        break;
      case "public_field_definition":
      case "field_definition": {
        const property = describeProperty(member);
        if (property !== undefined) {
          properties.push(property);
        }
        break;
      }
      default:
        // Decorators, comments, index signatures, static blocks, overload signatures.
        break;
    }
  }

  return {
    name,
    exported: context.exported,
    defaultExport: context.defaultExport,
    abstract: node.type === "abstract_class_declaration",
    ...(superclass === undefined ? {} : { extends: superclass }),
    implements: interfaces,
    properties,
    methods,
    startLine: startLine(node),
    endLine: endLine(node),
  };
}

/** Works for both `import_specifier` and `export_specifier` (same fields). */
function describeNamedSpecifier(specifier: SyntaxNode): ImportSpecifier {
  const original = specifier.childForFieldName("name")?.text ?? specifier.text;
  const alias = specifier.childForFieldName("alias")?.text;
  return {
    kind: "named",
    name: alias ?? original,
    ...(alias !== undefined && alias !== original ? { importedName: original } : {}),
    ...(hasKeyword(specifier, "type") ? { typeOnly: true } : {}),
  };
}

function describeImportClause(clause: SyntaxNode): ImportSpecifier[] {
  const specifiers: ImportSpecifier[] = [];
  for (const child of clause.namedChildren) {
    switch (child.type) {
      case "identifier":
        specifiers.push({ kind: "default", name: child.text });
        break;
      case "namespace_import":
        specifiers.push({ kind: "namespace", name: child.namedChildren[0]?.text ?? "*" });
        break;
      case "named_imports":
        for (const specifier of child.namedChildren) {
          if (specifier.type === "import_specifier") {
            specifiers.push(describeNamedSpecifier(specifier));
          }
        }
        break;
      default:
        break;
    }
  }
  return specifiers;
}

function describeImportStatement(node: SyntaxNode): ImportInfo | undefined {
  const line = startLine(node);

  // TypeScript `import x = require("y")`
  const requireClause = findNamedChild(node, "import_require_clause");
  if (requireClause !== undefined) {
    const source = stringLiteralValue(requireClause.childForFieldName("source"));
    const local = findNamedChild(requireClause, "identifier")?.text;
    if (source === undefined) {
      return undefined;
    }
    return { source, kind: "commonjs", typeOnly: false, specifiers: local === undefined ? [] : [{ kind: "default", name: local }], line };
  }

  const source = stringLiteralValue(node.childForFieldName("source"));
  if (source === undefined) {
    return undefined;
  }
  const clause = findNamedChild(node, "import_clause");
  return {
    source,
    kind: "esm",
    typeOnly: hasKeyword(node, "type"),
    specifiers: clause === undefined ? [] : describeImportClause(clause),
    line,
  };
}

function describeReExport(node: SyntaxNode, source: string): ImportInfo {
  const exportClause = findNamedChild(node, "export_clause");
  const namespaceExport = findNamedChild(node, "namespace_export");
  let specifiers: ImportSpecifier[];
  if (exportClause !== undefined) {
    specifiers = exportClause.namedChildren.filter((child) => child.type === "export_specifier").map(describeNamedSpecifier);
  } else {
    specifiers = [{ kind: "namespace", name: namespaceExport?.namedChildren[0]?.text ?? "*" }];
  }
  return { source, kind: "re-export", typeOnly: hasKeyword(node, "type"), specifiers, line: startLine(node) };
}

/** `const x = require("y")` / `const { a, b: c } = require("y")` bindings. */
function describeRequireBindings(pattern: SyntaxNode): ImportSpecifier[] {
  if (pattern.type === "identifier") {
    return [{ kind: "default", name: pattern.text }];
  }
  if (pattern.type !== "object_pattern") {
    return [];
  }
  return pattern.namedChildren.flatMap((property): ImportSpecifier[] => {
    if (property.type === "shorthand_property_identifier_pattern") {
      return [{ kind: "named", name: property.text }];
    }
    if (property.type === "pair_pattern") {
      const key = property.childForFieldName("key")?.text;
      const value = property.childForFieldName("value")?.text;
      if (key !== undefined && value !== undefined) {
        return [{ kind: "named", name: value, ...(key === value ? {} : { importedName: key }) }];
      }
    }
    return [];
  });
}

// ---------------------------------------------------------------------------
// Visitors
// ---------------------------------------------------------------------------

function pushClass(accumulator: Accumulator, classInfo: ClassInfo | undefined): void {
  if (classInfo !== undefined) {
    accumulator.classes.push(classInfo);
  }
}

function visitVariableDeclaration(node: SyntaxNode, accumulator: Accumulator, context: ExportContext): void {
  for (const declarator of node.namedChildren) {
    if (declarator.type !== "variable_declarator") {
      continue;
    }
    const pattern = declarator.childForFieldName("name");
    const initializer = declarator.childForFieldName("value");
    if (pattern === null || initializer === null) {
      continue;
    }

    const requiredSource = requireCallSource(initializer);
    if (requiredSource !== undefined) {
      accumulator.imports.push({
        source: requiredSource,
        kind: "commonjs",
        typeOnly: false,
        specifiers: describeRequireBindings(pattern),
        line: startLine(declarator),
      });
      continue;
    }

    if (pattern.type !== "identifier") {
      continue;
    }
    const value = unwrapExpression(initializer);
    if (FUNCTION_NODE_KINDS.has(value.type)) {
      accumulator.functions.push(describeFunction(value, pattern.text, declarator, context));
    } else if (value.type === "class") {
      pushClass(accumulator, describeClass(value, context, pattern.text));
    }
  }
}

type CommonJsExportTarget = { readonly kind: "module" } | { readonly kind: "member"; readonly name: string };

function commonJsExportTarget(left: SyntaxNode): CommonJsExportTarget | undefined {
  if (left.type !== "member_expression") {
    return undefined;
  }
  const path = left.text.replace(/\s+/g, "");
  if (path === "module.exports") {
    return { kind: "module" };
  }
  const member = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(path)?.[1];
  return member === undefined ? undefined : { kind: "member", name: member };
}

/** `module.exports = ...` and `exports.name = ...` (CommonJS modules). */
function visitCommonJsExport(assignment: SyntaxNode, accumulator: Accumulator): void {
  const left = assignment.childForFieldName("left");
  const right = assignment.childForFieldName("right");
  const target = left === null ? undefined : commonJsExportTarget(left);
  if (target === undefined || right === null) {
    return;
  }
  const value = unwrapExpression(right);
  const context: ExportContext = { exported: true, defaultExport: target.kind === "module" };
  const memberName = target.kind === "member" ? target.name : undefined;

  if (FUNCTION_NODE_KINDS.has(value.type)) {
    const name = memberName ?? value.childForFieldName("name")?.text ?? "module.exports";
    accumulator.functions.push(describeFunction(value, name, assignment, context));
  } else if (value.type === "class") {
    pushClass(accumulator, describeClass(value, context, memberName ?? value.childForFieldName("name")?.text ?? "module.exports"));
  } else if (value.type === "identifier") {
    (target.kind === "module" ? accumulator.lateDefaultExports : accumulator.lateExports).add(value.text);
  } else if (value.type === "object" && target.kind === "module") {
    for (const property of value.namedChildren) {
      if (property.type === "shorthand_property_identifier") {
        accumulator.lateExports.add(property.text);
      } else if (property.type === "pair") {
        const propertyValue = property.childForFieldName("value");
        if (propertyValue?.type === "identifier") {
          accumulator.lateExports.add(propertyValue.text);
        }
      }
    }
  }
}

function visitExpressionStatement(node: SyntaxNode, accumulator: Accumulator): void {
  const expression = node.namedChildren[0];
  if (expression === undefined) {
    return;
  }
  const requiredSource = requireCallSource(expression);
  if (requiredSource !== undefined) {
    // Side-effect `require("x");`
    accumulator.imports.push({ source: requiredSource, kind: "commonjs", typeOnly: false, specifiers: [], line: startLine(node) });
  } else if (expression.type === "assignment_expression") {
    visitCommonJsExport(expression, accumulator);
  }
}

function visitExportedValue(value: SyntaxNode, accumulator: Accumulator, context: ExportContext): void {
  const node = unwrapExpression(value);
  if (FUNCTION_NODE_KINDS.has(node.type)) {
    accumulator.functions.push(describeFunction(node, node.childForFieldName("name")?.text ?? "default", node, context));
  } else if (node.type === "class") {
    pushClass(accumulator, describeClass(node, context));
  } else if (node.type === "identifier") {
    accumulator.lateDefaultExports.add(node.text); // `export default foo;`
  }
}

function visitExportStatement(node: SyntaxNode, accumulator: Accumulator): void {
  const source = stringLiteralValue(node.childForFieldName("source"));
  if (source !== undefined) {
    accumulator.imports.push(describeReExport(node, source));
    return;
  }

  const context: ExportContext = hasKeyword(node, "default") ? { exported: true, defaultExport: true } : NAMED_EXPORT;
  const declaration = node.childForFieldName("declaration");
  if (declaration !== null) {
    visitStatement(declaration, accumulator, context);
    return;
  }
  const value = node.childForFieldName("value");
  if (value !== null) {
    visitExportedValue(value, accumulator, context);
    return;
  }
  // `export { a, b as c };` — marks earlier (or later) local declarations as exported.
  const exportClause = findNamedChild(node, "export_clause");
  for (const specifier of exportClause?.namedChildren ?? []) {
    const localName = specifier.type === "export_specifier" ? specifier.childForFieldName("name")?.text : undefined;
    if (localName !== undefined) {
      accumulator.lateExports.add(localName);
    }
  }
}

function visitStatement(node: SyntaxNode, accumulator: Accumulator, context: ExportContext): void {
  if (FUNCTION_STATEMENT_TYPES.has(node.type)) {
    const name = node.childForFieldName("name")?.text;
    if (name !== undefined) {
      const target = node.type === "function_signature" ? accumulator.signatures : accumulator.functions;
      target.push(describeFunction(node, name, node, context));
    }
    return;
  }

  const typeKind = TYPE_NODE_KINDS.get(node.type);
  if (typeKind !== undefined) {
    const name = node.childForFieldName("name")?.text;
    if (name !== undefined) {
      accumulator.types.push({ name, kind: typeKind, exported: context.exported, startLine: startLine(node), endLine: endLine(node) });
    }
    return;
  }

  if (CLASS_NODE_TYPES.has(node.type)) {
    pushClass(accumulator, describeClass(node, context));
    return;
  }

  switch (node.type) {
    case "import_statement": {
      const importInfo = describeImportStatement(node);
      if (importInfo !== undefined) {
        accumulator.imports.push(importInfo);
      }
      return;
    }
    case "export_statement":
      visitExportStatement(node, accumulator);
      return;
    case "lexical_declaration":
    case "variable_declaration":
      visitVariableDeclaration(node, accumulator, context);
      return;
    case "expression_statement":
      visitExpressionStatement(node, accumulator);
      return;
    case "ambient_declaration": // `declare function f(): void;`, `declare class C {}` ...
    case "ERROR": // best effort: recover declarations Tree-sitter could not attach to the tree
      for (const child of node.namedChildren) {
        visitStatement(child, accumulator, context);
      }
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

function collectSyntaxErrorLines(root: SyntaxNode): number[] {
  if (!root.hasError) {
    return [];
  }
  const lines = new Set<number>();
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0 && lines.size < MAX_REPORTED_SYNTAX_ERRORS) {
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    if (node.isError || node.isMissing) {
      lines.add(startLine(node));
      continue;
    }
    if (node.hasError) {
      // Only subtrees that contain errors are explored.
      for (let index = node.childCount - 1; index >= 0; index -= 1) {
        const child = node.child(index);
        if (child !== null) {
          stack.push(child);
        }
      }
    }
  }
  return [...lines].sort((left, right) => left - right);
}

interface Exportable {
  readonly name: string;
  readonly exported: boolean;
}

function applyLateExports<T extends Exportable>(item: T, accumulator: Accumulator): T {
  const lateNamed = accumulator.lateExports.has(item.name);
  const lateDefault = accumulator.lateDefaultExports.has(item.name);
  if (!lateNamed && !lateDefault) {
    return item;
  }
  return { ...item, exported: true, ...(lateDefault && "defaultExport" in item ? { defaultExport: true } : {}) };
}

/** Keeps ambient/overload signatures only for names without an implementation. */
function mergeSignatures(functions: readonly FunctionInfo[], signatures: readonly FunctionInfo[]): FunctionInfo[] {
  const implemented = new Set(functions.map((fn) => fn.name));
  const merged = [...functions];
  for (const signature of signatures) {
    if (!implemented.has(signature.name)) {
      implemented.add(signature.name);
      merged.push(signature);
    }
  }
  return merged.sort((left, right) => left.startLine - right.startLine);
}

function countLines(source: string): number {
  if (source.length === 0) {
    return 0;
  }
  let newlines = 0;
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) {
    newlines += 1;
  }
  return source.endsWith("\n") ? newlines : newlines + 1;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildFileStructure(tree: SyntaxTree, source: string, filePath: string, language: LanguageId): FileStructure {
  const accumulator: Accumulator = {
    imports: [],
    classes: [],
    functions: [],
    signatures: [],
    types: [],
    lateExports: new Set(),
    lateDefaultExports: new Set(),
  };

  const root = tree.rootNode;
  for (const statement of root.namedChildren) {
    visitStatement(statement, accumulator, NOT_EXPORTED);
  }

  return {
    filePath,
    language,
    lineCount: countLines(source),
    hasSyntaxErrors: root.hasError,
    syntaxErrorLines: collectSyntaxErrorLines(root),
    imports: accumulator.imports,
    classes: accumulator.classes.map((classInfo) => applyLateExports(classInfo, accumulator)),
    functions: mergeSignatures(accumulator.functions, accumulator.signatures).map((fn) => applyLateExports(fn, accumulator)),
    types: accumulator.types.map((typeInfo) => applyLateExports(typeInfo, accumulator)),
  };
}
